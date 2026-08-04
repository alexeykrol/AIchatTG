// Compatibility export for local callers during the portability transition.
// New runtime code must use provider-adapter.mjs and its explicit Provider name.
export {
  ProviderUnavailableError as LlmDisabledError,
  createProviderAdapter as createLlmAdapter,
} from './provider-adapter.mjs';
