/* Local PP-OCRv5 name recognition. See name-NOTICE.txt for provenance. */
'use strict';
let session;
let characters;
let ortRuntime;
const origin = self.location.origin;
const asset = name => new URL(`/concierge/ocr/${name}`, origin).href;
async function initialize() {
  if (session) return;
  importScripts(asset('name-runtime/ort.wasm.min.js'));
  ortRuntime = self.ort;
  if (!ortRuntime?.InferenceSession) throw new Error('中文名称引擎未正确加载');
  ortRuntime.env.wasm.numThreads = 1;
  ortRuntime.env.wasm.proxy = false;
  ortRuntime.env.wasm.wasmPaths = asset('name-runtime/');
  const [modelResponse, dictionaryResponse] = await Promise.all([fetch(asset('name-model.onnx')), fetch(asset('name-characters.json'))]);
  if (!modelResponse.ok || !dictionaryResponse.ok) throw new Error('中文名称模型下载失败');
  const model = await modelResponse.arrayBuffer();
  if (model.byteLength !== 16631306) throw new Error('中文名称模型下载不完整');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', model))).map(value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== '5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5') throw new Error('中文名称模型校验失败');
  characters = await dictionaryResponse.json();
  if (!Array.isArray(characters) || characters.length !== 18385 || characters.some(value => typeof value !== 'string')) throw new Error('中文名称字符表不完整');
  session = await ortRuntime.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] });
}
async function recognize(message) {
  if (!session) throw new Error('中文名称模型尚未加载');
  const width = Number(message.width), paddedWidth = Number(message.paddedWidth), bytes = message.rgba;
  if (!Number.isInteger(width) || !Number.isInteger(paddedWidth) || width < 1 || width > paddedWidth || paddedWidth < 320 || paddedWidth > 2048 || !(bytes instanceof ArrayBuffer) || bytes.byteLength !== width * 48 * 4) throw new Error('项目名称图片尺寸不正确');
  const rgba = new Uint8Array(bytes), data = new Float32Array(3 * 48 * paddedWidth);
  for (let y = 0; y < 48; y++) for (let x = 0; x < width; x++) for (let channel = 0; channel < 3; channel++) data[channel * 48 * paddedWidth + y * paddedWidth + x] = rgba[(y * width + x) * 4 + (2 - channel)] / 127.5 - 1;
  const input = new ortRuntime.Tensor('float32', data, [1, 3, 48, paddedWidth]);
  let outputs;
  try {
    outputs = await session.run({ [session.inputNames[0]]: input });
    const output = outputs[session.outputNames[0]], values = output.data, steps = output.dims[1], classes = output.dims[2];
    if (classes !== characters.length || steps > 1024) throw new Error('中文名称输出格式不正确');
    let previous = -1, text = '', score = 0, count = 0;
    for (let step = 0; step < steps; step++) {
      let best = 0;
      for (let index = 1; index < classes; index++) if (values[step * classes + index] > values[step * classes + best]) best = index;
      if (best !== 0 && best !== previous) { text += characters[best] || ''; score += values[step * classes + best]; count++; }
      previous = best;
    }
    return { text, confidence: count ? score / count : 0 };
  } finally { input.dispose?.(); if (outputs) for (const tensor of Object.values(outputs)) tensor.dispose?.(); }
}
self.onmessage = async event => {
  const message = event.data || {}, id = message.id;
  try {
    let result;
    if (message.action === 'init') { await initialize(); result = { ready: true }; }
    else if (message.action === 'line') result = await recognize(message);
    else if (message.action === 'release') { if (session) await session.release(); session = undefined; characters = undefined; result = { released: true }; }
    else throw new Error('不支持的名称识别操作');
    self.postMessage({ id, result });
  } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : '本机中文名称识别失败' }); }
};
