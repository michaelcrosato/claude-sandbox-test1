import { describeEventTypeStoreContract } from "./conformance.js";
import { InMemoryEventTypeStore } from "./in-memory-event-type-store.js";

let t = 1_700_000_000_000;

describeEventTypeStoreContract(() => new InMemoryEventTypeStore({ now: () => ++t }));
