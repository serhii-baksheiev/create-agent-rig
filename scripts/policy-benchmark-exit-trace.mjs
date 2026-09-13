// A preload for one bounded diagnostic (RP-111, PR #202): what a guard process
// does between writing its answer and actually exiting.
//
// Loaded as `node --import <this file> <guard>`. When POLICY_BENCHMARK_EXIT_TRACE
// names a file, it appends one line per mark — `<mark> <ms since process start>`:
//
//   preload                        this module ran (Node bootstrap is done)
//   stdout-write / stderr-write    the first write to that stream
//   exit-event <code>              process 'exit' fired (main logic is over)
//   reallyExit <code> handles=<n>  process.exit() reached the native exit call
//
// On the hosted windows-latest runner a guard had its 352-byte refusal on stderr
// and still had not exited 30 s later. These marks say which side of the native
// exit call the time goes to: a trace that ends at `reallyExit` while the parent
// still waits for the 'exit' event is time spent in the runtime's teardown, not
// in the guard's code; a trace that ends at `stderr-write` is a guard whose main
// logic did not finish.
//
// It never changes the traced process: no env var, or any failure to open or
// write the trace, means no trace and nothing else — the exit code, stdout and
// stderr are the guard's own. Pinned in policy-benchmark-exit-trace.test.ts ›
// "never throws or changes the exit code or stderr when the trace path names an
// existing directory instead of a file".
import { closeSync, openSync, writeSync } from 'node:fs';

const target = process.env.POLICY_BENCHMARK_EXIT_TRACE;
if (typeof target === 'string' && target !== '') {
  let fd = null;
  try {
    fd = openSync(target, 'a');
  } catch {
    fd = null;
  }
  const mark = (label) => {
    if (fd === null) return;
    try {
      writeSync(fd, `${label} ${Math.round(performance.now())}\n`);
    } catch {
      // A trace that cannot be written is a trace that is not written.
    }
  };
  const traceFirstWrite = (stream, label) => {
    const original = stream.write;
    stream.write = function tracedWrite(...args) {
      stream.write = original;
      mark(label);
      return original.apply(this, args);
    };
  };
  mark('preload');
  traceFirstWrite(process.stdout, 'stdout-write');
  traceFirstWrite(process.stderr, 'stderr-write');
  process.on('exit', (code) => mark(`exit-event ${code}`));
  const reallyExit = process.reallyExit;
  if (typeof reallyExit === 'function') {
    process.reallyExit = function tracedReallyExit(code) {
      let handles;
      try {
        handles = process._getActiveHandles().length;
      } catch {
        handles = 0;
      }
      mark(`reallyExit ${code} handles=${handles}`);
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Already closed or never usable; nothing to release.
        }
        fd = null;
      }
      return reallyExit.call(this, code);
    };
  }
}
