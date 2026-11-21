import { readFileSync } from 'node:fs';

/**
 * Sentence embedder for the hybrid retriever: paraphrase-multilingual-MiniLM-L12-v2
 * as an INT8-quantized ONNX graph, run in-process by onnxruntime-node.
 *
 * One recipe, used on both sides: the package build (`scripts/kb/build_hybrid_package.mjs`)
 * imports this module to embed passage pieces, and the runtime uses it to embed the
 * question. Same tokenizer.json, same graph, same pooling — so the two sides cannot
 * drift apart. The recipe is sentence-transformers' own for this model:
 *   tokenize (XLM-R unigram, max 128 tokens incl. <s>/</s>, longest-first truncation)
 *   → last_hidden_state → mean over attention_mask → L2 normalize.
 *
 * Memory discipline (the production host has ~1 GB free and no swap): nothing is
 * loaded until the first embed call, the session is created once per process, and
 * ONNX Runtime runs with one intra-op and one inter-op thread.
 *
 * Offline only: files are read from local paths; there is no download path.
 */

export const EMBEDDER_RECIPE = Object.freeze({
  model: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
  revision: 'e8f8c211226b894fcb81acc59f3b34ba3efd5f42',
  graph: 'onnx/model_quint8_avx2.onnx',
  pooling: 'mean_attention_mask',
  normalize: 'l2',
  maxLength: 128,
  dim: 384,
});

/**
 * Where the model lives: inside the knowledge package, next to the vectors it
 * produced, and listed (sha256) in knowledge.manifest.json — so admission proves
 * the model exactly like it proves ai.db, and the image stays model-free.
 */
export const PACKAGE_MODEL_FILES = Object.freeze({
  model: 'model/model_quint8_avx2.onnx',
  tokenizer: 'model/tokenizer.json',
  tokenizerConfig: 'model/tokenizer_config.json',
});

function defaultLoadOrt() {
  // onnxruntime 1.31 ships 1DS telemetry that posts to events.data.microsoft.com
  // from Linux builds. The bot must not phone home: switch it off before the
  // native library initializes (the image also sets it; this covers any other
  // launcher). An operator who explicitly sets the variable keeps their value.
  if (process.env.ORT_DISABLE_TELEMETRY === undefined) process.env.ORT_DISABLE_TELEMETRY = '1';
  return import('onnxruntime-node');
}

/**
 * Memory diet for the 250k-piece Unigram vocabulary (production host: ~1 GB
 * free, no swap). tokenizers.js builds a character trie of every piece — about
 * 120 MB of JS objects for this model, and the build itself is the peak — only
 * to answer "which vocabulary pieces are prefixes of the text at position i".
 *
 * So the Tokenizer is constructed over a stub vocabulary (the first unk_id+1
 * pieces, enough for its constructor), and the real vocabulary is installed
 * afterwards exactly as the Unigram constructor would (vocab, scores, piece→id
 * map, bos/eos ids, unk score = min score − 10), followed by the added-token
 * overrides the Tokenizer constructor applies. The trie is replaced by probing
 * the piece→id map for prefixes up to the longest piece length, in increasing
 * length — the order a trie walk yields them; pieces that exist only as added
 * tokens are excluded, as they were never in the trie. Token ids are verified
 * identical to the Python `tokenizers` output on every passage piece and every
 * eval question (see the hybrid integration report).
 */
export function createCompactTokenizer(Tokenizer, json, config = {}) {
  const model = json?.model;
  if (!model || model.type !== 'Unigram' || !Array.isArray(model.vocab)
    || !Number.isInteger(model.unk_id) || model.vocab.length <= model.unk_id + 1) {
    return new Tokenizer(json, config);
  }
  const pairs = model.vocab;
  const tokenizer = new Tokenizer({ ...json, model: { ...model, vocab: pairs.slice(0, model.unk_id + 1) } }, config);
  const m = tokenizer.model;
  const n = pairs.length;
  const vocab = new Array(n);
  const scores = new Array(n);
  let maxLen = 0;
  for (let i = 0; i < n; i += 1) {
    [vocab[i], scores[i]] = pairs[i];
    const len = [...String(vocab[i])].length;
    if (len > maxLen) maxLen = len;
  }
  m.vocab = vocab;
  m.scores = scores;
  m.unk_token_id = model.unk_id;
  m.unk_token = vocab[model.unk_id];
  m.tokens_to_ids = new Map(vocab.map((piece, i) => [piece, i]));
  m.bos_token = ' ';
  m.bos_token_id = m.tokens_to_ids.get(m.bos_token);
  m.eos_token_id = m.tokens_to_ids.get(m.eos_token);
  let minScore = scores[0];
  for (let i = 1; i < n; i += 1) if (scores[i] < minScore) minScore = scores[i];
  m.min_score = minScore;
  m.unk_score = minScore - 10;
  scores[model.unk_id] = m.unk_score;
  const addedOnly = new Set();
  for (const token of tokenizer.added_tokens || []) {
    if (!m.tokens_to_ids.has(token.content)) addedOnly.add(token.content);
    m.tokens_to_ids.set(token.content, token.id);
    m.vocab[token.id] = token.content;
  }
  const ids = m.tokens_to_ids;
  m.trie = {
    * common_prefix_search(chars, start = 0) {
      let prefix = '';
      const end = Math.min(chars.length, start + maxLen);
      for (let i = start; i < end; i += 1) {
        prefix += chars[i];
        if (ids.has(prefix) && !addedOnly.has(prefix)) yield prefix;
      }
    },
  };
  // Constructor-only inputs; nothing reads them afterwards.
  m.config = { fuse_unk: m.config?.fuse_unk };
  if ('tokenizer' in tokenizer) tokenizer.tokenizer = null;
  return tokenizer;
}

async function defaultLoadTokenizer(tokenizerPath, tokenizerConfigPath) {
  const { Tokenizer } = await import('@huggingface/tokenizers');
  const config = tokenizerConfigPath ? JSON.parse(readFileSync(tokenizerConfigPath, 'utf8')) : {};
  return createCompactTokenizer(Tokenizer, JSON.parse(readFileSync(tokenizerPath, 'utf8')), config);
}

/** Token ids with the model's truncation: keep <s> + first (max-2) tokens + </s>. */
export function truncateIds(ids, maxLength) {
  if (ids.length <= maxLength) return ids;
  return [...ids.slice(0, maxLength - 1), ids[ids.length - 1]];
}

/** Mean over the attention mask, then L2 normalization. `hidden` is [batch, seq, dim] flat. */
export function meanPoolNormalize(hidden, mask, batch, seq, dim) {
  const out = [];
  for (let b = 0; b < batch; b += 1) {
    const vec = new Float32Array(dim);
    let count = 0;
    for (let t = 0; t < seq; t += 1) {
      if (!mask[b * seq + t]) continue;
      count += 1;
      const base = (b * seq + t) * dim;
      for (let d = 0; d < dim; d += 1) vec[d] += hidden[base + d];
    }
    let norm = 0;
    for (let d = 0; d < dim; d += 1) { vec[d] /= Math.max(count, 1); norm += vec[d] * vec[d]; }
    norm = Math.max(Math.sqrt(norm), 1e-12);
    for (let d = 0; d < dim; d += 1) vec[d] /= norm;
    out.push(vec);
  }
  return out;
}

export function createEmbedder(
  {
    modelPath,
    tokenizerPath,
    tokenizerConfigPath = null,
    maxLength = EMBEDDER_RECIPE.maxLength,
    padId = 1,
  } = {},
  { loadOrt = defaultLoadOrt, loadTokenizer = defaultLoadTokenizer } = {},
) {
  let ready = null;

  function load() {
    if (!ready) {
      ready = (async () => {
        if (typeof modelPath !== 'string' || !modelPath) throw new Error('embedder_model_missing');
        if (typeof tokenizerPath !== 'string' || !tokenizerPath) throw new Error('embedder_tokenizer_missing');
        const tokenizer = await loadTokenizer(tokenizerPath, tokenizerConfigPath);
        const ort = await loadOrt();
        const session = await ort.InferenceSession.create(modelPath, {
          intraOpNumThreads: 1,
          interOpNumThreads: 1,
          executionMode: 'sequential',
          graphOptimizationLevel: 'all',
        });
        return { tokenizer, ort, session };
      })();
    }
    return ready;
  }

  /** Embed a batch of texts; resolves to one L2-normalized Float32Array per text. */
  async function embed(texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    if (!list.length) return [];
    const { tokenizer, ort, session } = await load();
    const encoded = list.map((text) => truncateIds(tokenizer.encode(String(text ?? '')).ids, maxLength));
    const seq = Math.max(...encoded.map((ids) => ids.length));
    const batch = encoded.length;
    const inputIds = new BigInt64Array(batch * seq).fill(BigInt(padId));
    const mask = new BigInt64Array(batch * seq);
    encoded.forEach((ids, b) => ids.forEach((id, t) => {
      inputIds[b * seq + t] = BigInt(id);
      mask[b * seq + t] = 1n;
    }));
    const feeds = {
      input_ids: new ort.Tensor('int64', inputIds, [batch, seq]),
      attention_mask: new ort.Tensor('int64', mask, [batch, seq]),
    };
    if (session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(batch * seq), [batch, seq]);
    }
    const result = await session.run(feeds);
    const hidden = result.last_hidden_state ?? result[session.outputNames[0]];
    const dim = hidden.dims[2];
    return meanPoolNormalize(hidden.data, Array.from(mask, Number), batch, seq, dim);
  }

  return Object.freeze({
    embed,
    async embedOne(text) { return (await embed([text]))[0]; },
    /** Force the lazy load (used by measurements); resolves when the session is ready. */
    async warm() { await load(); },
  });
}
