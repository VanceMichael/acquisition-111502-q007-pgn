// 来源领取与自动接入：领取入口与交付声明的 roots，保留真实原文收件，
// 再把棋谱正文解释为结构化记录与问题写入资料集。不执行交付件，不访问冻结 origin 之外的主机。

import { retrieve } from './transport.mjs';
import { summarize } from './summary.mjs';
import { interpretPgn } from './pgn.mjs';
import { identifier } from './archive.mjs';

function deliveryRoots(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (value && Array.isArray(value.roots)) {
      return value.roots
        .map(root => typeof root === 'string' ? root : root && root.href)
        .filter(href => typeof href === 'string');
    }
  } catch {}
  return null;
}

export async function acquire(archive, { collectionId, entry, allowedOrigin }) {
  identifier(collectionId);
  const receiptIds = [];
  const fetched = new Map();
  const issues = [];
  const records = [];

  async function fetchAndReceive(url) {
    if (fetched.has(url)) return fetched.get(url);
    const result = await retrieve(url, allowedOrigin);
    const receipt = await archive.receive({
      collectionId,
      sourceKey: url,
      revision: result.revision,
      mediaType: result.mediaType,
      bytes: result.bytes,
      summary: summarize(result.bytes, result.mediaType)
    });
    const item = { receipt, bytes: result.bytes };
    fetched.set(url, item);
    receiptIds.push(receipt.receiptId);
    return item;
  }

  const entryItem = await fetchAndReceive(entry);
  const roots = deliveryRoots(entryItem.bytes);
  const sources = [];
  if (roots) {
    for (const href of roots) {
      const url = new URL(href, entry).href;
      try {
        sources.push(await fetchAndReceive(url));
      } catch (error) {
        issues.push({
          reason: 'resource_unavailable',
          location: url,
          detail: error.message,
          receiptId: entryItem.receipt.receiptId
        });
      }
    }
  } else {
    sources.push(entryItem);
  }

  for (const source of sources) {
    const interpreted = interpretPgn(source.bytes, source.receipt.receiptId);
    records.push(...interpreted.records);
    issues.push(...interpreted.issues);
  }
  await archive.applyInterpretation(collectionId, { records, issues });
  return { collectionId, receiptIds };
}
