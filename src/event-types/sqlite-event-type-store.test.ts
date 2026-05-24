import { describeEventTypeStoreContract } from "./conformance.js";
import { SqliteEventTypeStore } from "./sqlite-event-type-store.js";

describeEventTypeStoreContract(() => new SqliteEventTypeStore({ location: ":memory:" }));
