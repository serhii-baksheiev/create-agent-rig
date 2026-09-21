// Fixed Windows-only supervisor. The payload is constructed by a compiled
// adapter; repository declarations never reach this script as executable code.
export const WINDOWS_JOB_SUPERVISOR = String.raw`
$ErrorActionPreference = 'Stop'
if ($env:RIG_WINDOWS_JOB_PROBE -eq '1') { [Console]::Error.WriteLine('rig-probe:entered') }
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class RigJob
{
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const int JobObjectExtendedLimitInformation = 9;
    const int JobObjectBasicAccountingInformation = 1;
    const int JobObjectAssociateCompletionPortInformation = 7;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = (IntPtr)0x0002000D;
    const uint INFINITE = 0xffffffff;
    const uint JOB_OBJECT_MSG_NEW_PROCESS = 6;
    const uint JOB_OBJECT_MSG_EXIT_PROCESS = 7;
    const uint JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS = 8;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT
    {
        public IntPtr CompletionKey;
        public IntPtr CompletionPort;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateIoCompletionPort(IntPtr fileHandle, IntPtr existingPort,
        IntPtr completionKey, uint threads);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetQueuedCompletionStatus(IntPtr port, out uint bytes,
        out IntPtr completionKey, out IntPtr overlapped, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
        IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
        IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static void Check(bool value)
    {
        if (!value) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            result.Append(character);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    static IntPtr CreateJob(IntPtr port)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(limits);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, size));
            var association = new JOBOBJECT_ASSOCIATE_COMPLETION_PORT();
            association.CompletionKey = (IntPtr)1;
            association.CompletionPort = port;
            int associationSize = Marshal.SizeOf(association);
            IntPtr associationBuffer = Marshal.AllocHGlobal(associationSize);
            try
            {
                Marshal.StructureToPtr(association, associationBuffer, false);
                Check(SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation,
                    associationBuffer, associationSize));
            }
            finally { Marshal.FreeHGlobal(associationBuffer); }
            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    static int DrainEvents(IntPtr port, int members)
    {
        uint message;
        IntPtr key, process;
        while (GetQueuedCompletionStatus(port, out message, out key, out process, 0))
        {
            if (message == JOB_OBJECT_MSG_NEW_PROCESS) members++;
            if (message == JOB_OBJECT_MSG_EXIT_PROCESS ||
                message == JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS) members--;
        }
        return members;
    }

    // The JOB_LIST attribute is attached to CreateProcess itself, so there is
    // no created-but-unassigned provider interval for a helper kill to expose.
    static PROCESS_INFORMATION CreateInJob(IntPtr job, string executable, string command, string cwd)
    {
        IntPtr attributeList = IntPtr.Zero;
        IntPtr jobList = IntPtr.Zero;
        bool initialized = false;
        try
        {
            IntPtr attributeBytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
            if (attributeBytes == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            attributeList = Marshal.AllocHGlobal(attributeBytes);
            Check(InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeBytes));
            initialized = true;
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            Check(UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                jobList, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero));
            var startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.lpAttributeList = attributeList;
            PROCESS_INFORMATION process;
            Check(CreateProcess(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
                true, EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, ref startup, out process));
            if (Environment.GetEnvironmentVariable("RIG_WINDOWS_JOB_PROBE") == "1") Console.Error.WriteLine("rig-probe:created");
            return process;
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(attributeList);
            if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
        }
    }

    public static int Run(string executable, string command, string cwd)
    {
        IntPtr port = CreateIoCompletionPort((IntPtr)(-1), IntPtr.Zero, IntPtr.Zero, 1);
        if (port == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr job = IntPtr.Zero;
        int members = 0;
        try
        {
            job = CreateJob(port);
            PROCESS_INFORMATION process = CreateInJob(job, executable, command, cwd);
            try
            {
                WaitForSingleObject(process.hProcess, INFINITE);
                members = DrainEvents(port, members);
                uint exitCode;
                Check(GetExitCodeProcess(process.hProcess, out exitCode));
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
                do
                {
                    Check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                        out accounting, Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
                        IntPtr.Zero));
                    if (accounting.ActiveProcesses != 0) Thread.Sleep(10);
                } while (accounting.ActiveProcesses != 0);
                // Give job notifications already queued by a just-exited root
                // one bounded scheduling turn before accepting active-zero.
                Thread.Sleep(20);
                members = DrainEvents(port, members);
                return members == 0 ? unchecked((int)exitCode) : 125;
            }
            finally
            {
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
            }
        }
        finally
        {
            if (job != IntPtr.Zero) CloseHandle(job);
            CloseHandle(port);
        }
    }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
if ($env:RIG_WINDOWS_JOB_PROBE -eq '1') { [Console]::Error.WriteLine('rig-probe:compiled') }
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:RIG_WINDOWS_JOB_PAYLOAD)) | ConvertFrom-Json
$exe = [string]$payload.executable
$cwd = [string]$payload.cwd
$parts = @($payload.args | ForEach-Object { [RigJob]::Quote([string]$_) })
$command = ([RigJob]::Quote($exe)) + (($parts | ForEach-Object { ' ' + $_ }) -join '')
exit [RigJob]::Run($exe, $command, $cwd)
`;
