🧪 Add tests for createBillingProvider

🎯 What: The testing gap addressed
This PR introduces unit tests for the `createBillingProvider` factory function in `src/billing/index.ts`. Previously there were no tests for this core factory logic which governs the initialization of the underlying billing providers.

📊 Coverage: What scenarios are now tested
- Validates that when `provider` is `"none"` in the config, a `NoopBillingProvider` instance is appropriately created and returned.
- Validates that when `provider` is `"stripe"` in the config, a `StripeBillingProvider` instance is correctly created with the mapped properties and injected dependencies.

✨ Result: The improvement in test coverage
Ensures that the billing provider logic is working exactly as expected, increasing confidence in the `billing` module, preventing regression, and establishing a baseline for adding more intricate or parameterized billing configurations in the future.
