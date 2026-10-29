import { DomainError } from '../domain.js';

type ShutdownOptions = {
  stopWork: () => Promise<void>; destroyClient: () => Promise<void>; closeStore: () => void;
  stopHealth: () => void; onError: (error: unknown) => void; forceExit: () => void; timeoutMs?: number;
};

/** One shutdown, even for concurrent signals. Never close SQLite while work is in flight. */
export function createRoomsShutdown(options: ShutdownOptions): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    if (closing) return closing;
    // Defer callbacks until closing has been assigned, protecting reentrant calls.
    closing = Promise.resolve().then(async () => {
      const timer = setTimeout(() => {
        options.onError(new DomainError('ROOM_SHUTDOWN_TIMEOUT', 'O encerramento excedeu o prazo. Operações pendentes serão reconciliadas no próximo início.'));
        options.forceExit();
      }, options.timeoutMs ?? 25_000);
      try {
        options.stopHealth();
        await options.stopWork();
        await options.destroyClient();
        options.closeStore();
      } catch (error) {
        // If stopWork failed, do not race its outstanding database operations.
        options.onError(error); options.forceExit();
        throw error;
      } finally { clearTimeout(timer); }
    });
    return closing;
  };
}
