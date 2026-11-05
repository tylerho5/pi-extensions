import { runRefKey } from "./result-delivery.ts";
import type { SubagentRunRef } from "./domain.ts";

export interface DeliveryReservation {
  scheduled(): void;
  consumed(): void;
  fail(): void;
}

export interface CompletionGate {
  setModelActive(active: boolean): void;
  setChildWork(count: number): void;
  reserveDelivery(ref: SubagentRunRef): DeliveryReservation;
  canSettle(): boolean;
  subscribe(listener: () => void): () => void;
  close(): void;
}

export function createCompletionGate(): CompletionGate {
  let modelActive = false;
  let childWork = 0;
  let closed = false;
  const listeners = new Set<() => void>();
  const reservations = new Map<
    string,
    { scheduled: boolean; terminal: boolean }
  >();
  const publish = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* Observer failure does not alter gate state. */
      }
    }
  };
  const settleable = () =>
    !modelActive && childWork === 0 && reservations.size === 0;
  const update = (change: () => void) => {
    change();
    publish();
  };
  const finish = (
    key: string,
    reservation: { scheduled: boolean; terminal: boolean },
  ) =>
    update(() => {
      if (reservation.terminal) return;
      reservation.terminal = true;
      if (reservations.get(key) === reservation) reservations.delete(key);
    });
  return {
    setModelActive(active) {
      if (!closed && active !== modelActive)
        update(() => {
          modelActive = active;
        });
    },
    setChildWork(count) {
      if (closed) return;
      if (!Number.isSafeInteger(count) || count < 0)
        throw new RangeError(
          "Child work count must be a non-negative safe integer.",
        );
      if (count !== childWork)
        update(() => {
          childWork = count;
        });
    },
    reserveDelivery(ref) {
      if (closed) return { scheduled() {}, consumed() {}, fail() {} };
      const key = runRefKey(ref);
      let reservation = reservations.get(key);
      if (!reservation) {
        reservation = { scheduled: false, terminal: false };
        update(() => {
          reservations.set(key, reservation!);
        });
      }
      return {
        scheduled() {
          if (!closed && !reservation!.terminal && !reservation!.scheduled) {
            reservation!.scheduled = true;
            publish();
          }
        },
        consumed() {
          finish(key, reservation!);
        },
        fail() {
          finish(key, reservation!);
        },
      };
    },
    canSettle: settleable,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (closed) return;
      update(() => {
        closed = true;
        modelActive = false;
        childWork = 0;
        reservations.clear();
      });
      listeners.clear();
    },
  };
}
