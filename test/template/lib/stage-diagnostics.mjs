import { performance } from 'node:perf_hooks';

const ownValue = (error, key) =>
  error && typeof error === 'object'
    ? Object.getOwnPropertyDescriptor(error, key)?.value
    : undefined;
const bytes = (value) =>
  Buffer.isBuffer(value) ? value.length : typeof value === 'string' ? Buffer.byteLength(value) : 0;
const failureMetadata = (error) => {
  const status = ownValue(error, 'status');
  const signal = ownValue(error, 'signal');
  return (
    ` status=${Number.isSafeInteger(status) ? status : 'none'}` +
    ` signal=${typeof signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(signal) ? signal : 'none'}` +
    ` stdoutBytes=${bytes(ownValue(error, 'stdout'))} stderrBytes=${bytes(ownValue(error, 'stderr'))}`
  );
};

export const createStageDiagnostics = ({
  now = () => performance.now(),
  emit = console.error,
} = {}) => {
  const begin = (label) => {
    if (typeof label !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(label)) {
      throw new Error('stage label must be 1-64 lowercase letters, digits or hyphens');
    }
    const started = now();
    emit(`stage=${label} event=START`);
    return (event, error) =>
      emit(
        `stage=${label} event=${event} elapsedMs=${Math.max(0, Math.round(now() - started))}${event === 'FAILED' ? failureMetadata(error) : ''}`,
      );
  };
  return {
    runSync(label, operation) {
      const finish = begin(label);
      try {
        const value = operation();
        finish('COMPLETE');
        return value;
      } catch (error) {
        finish('FAILED', error);
        throw error;
      }
    },
    async run(label, operation) {
      const finish = begin(label);
      try {
        const value = await operation();
        finish('COMPLETE');
        return value;
      } catch (error) {
        finish('FAILED', error);
        throw error;
      }
    },
  };
};
