1. **Add test for timeout clearing on rejection**: I will add a new test to `src/system-events/system-events.test.ts` inside the `describe("systemEventTransportFrom")` block.
   - The test will be named `"clears the timeout when the transport rejects (no late abort)"`.
   - It will use `vi.useFakeTimers()` to verify that when a transport throws, no timer is left scheduled. This covers the edge case in `systemEventTransportFrom`'s `try/finally` block when the transport rejects, ensuring `clearTimeout(timer)` is called and the timer doesn't leak.
2. **Verify tests pass**: Run `npx vitest run src/system-events/system-events.test.ts` to ensure the new test behaves correctly and everything passes.
3. **Complete pre-commit checks**: Complete pre commit steps to make sure proper testing, verifications, reviews and reflections are done.
4. **Submit PR**: Submit the changes with a PR description that accurately explains the testing improvement.
