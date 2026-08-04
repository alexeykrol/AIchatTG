import { openExistingStore } from './ops-store.mjs';

const { store } = openExistingStore();
try {
  console.log(JSON.stringify(store.operationalStatus(), null, 2));
} finally {
  store.close();
}
