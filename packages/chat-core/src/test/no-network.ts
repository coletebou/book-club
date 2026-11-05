/**
 * Every test runs offline: the core has no business with the network, and a test that reaches for
 * it (an agent webhook fake that forgot to stub, a store that fetches) must fail at once, loudly,
 * rather than hang on a socket or pass by accident against something real.
 */
globalThis.fetch = () => {
  throw new Error('chat-core tests run offline: inject a fake instead of calling fetch');
};
