// PGN 棋谱正文解释：标签、SAN、注释、NAG、RAV 嵌套变化、SetUp/FEN。
// 变化的起始局面由棋局上下文决定（被变化着法之前的局面），不是按括号拼树。
// 非法或含糊着法记录问题并指出无法继续解释的位置与剩余范围，其余已确认内容不受影响。

import { initialPosition, parseFEN, resolveSAN, applyMove, startPly } from './chess.mjs';

const BRACE_OPEN = 0x7b;
const BRACE_CLOSE = 0x7d;
const PAREN_OPEN = 0x28;
const PAREN_CLOSE = 0x29;
const DOLLAR = 0x24;
const BRACKET_OPEN = 0x5b;
const BRACKET_CLOSE = 0x5d;
const SEMICOLON = 0x3b;
const PERCENT = 0x25;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const NEWLINE = 0x0a;

function isSpace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x00;
}

function isSymbolBreak(byte) {
  return isSpace(byte) || byte === BRACE_OPEN || byte === BRACE_CLOSE || byte === PAREN_OPEN ||
    byte === PAREN_CLOSE || byte === DOLLAR || byte === BRACKET_OPEN || byte === BRACKET_CLOSE ||
    byte === SEMICOLON || byte === PERCENT;
}

// 在原始字节上扫描记号，location 直接对应收件正文的字节区间。
export function tokenize(bytes) {
  const tokens = [];
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i];
    if (isSpace(byte)) { i++; continue; }
    if (byte === PERCENT && (i === 0 || bytes[i - 1] === NEWLINE)) {
      while (i < bytes.length && bytes[i] !== NEWLINE) i++;
      continue;
    }
    if (byte === BRACE_OPEN) {
      const start = i++;
      while (i < bytes.length && bytes[i] !== BRACE_CLOSE) i++;
      const end = i < bytes.length ? i + 1 : i;
      tokens.push({ type: 'comment', text: bytes.subarray(start + 1, i).toString('utf8'), start, end });
      i = end;
      continue;
    }
    if (byte === SEMICOLON) {
      const start = i++;
      while (i < bytes.length && bytes[i] !== NEWLINE) i++;
      tokens.push({ type: 'comment', text: bytes.subarray(start + 1, i).toString('utf8'), start, end: i });
      continue;
    }
    if (byte === PAREN_OPEN) { tokens.push({ type: 'open', start: i, end: i + 1 }); i++; continue; }
    if (byte === PAREN_CLOSE) { tokens.push({ type: 'close', start: i, end: i + 1 }); i++; continue; }
    if (byte === DOLLAR) {
      const start = i++;
      let value = 0;
      while (i < bytes.length && bytes[i] >= 0x30 && bytes[i] <= 0x39) value = value * 10 + (bytes[i++] - 0x30);
      tokens.push({ type: 'nag', value, start, end: i });
      continue;
    }
    if (byte === BRACKET_OPEN) {
      const start = i++;
      let quoted = false;
      let escaped = false;
      while (i < bytes.length) {
        const current = bytes[i];
        if (escaped) escaped = false;
        else if (current === BACKSLASH && quoted) escaped = true;
        else if (current === QUOTE) quoted = !quoted;
        else if (current === BRACKET_CLOSE && !quoted) break;
        i++;
      }
      const end = i < bytes.length ? i + 1 : i;
      const raw = bytes.subarray(start, end).toString('utf8');
      const tag = raw.match(/^\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]$/s);
      if (tag) tokens.push({ type: 'tag', name: tag[1], value: tag[2].replace(/\\(["\\])/g, '$1'), start, end });
      else tokens.push({ type: 'unknown', start, end });
      i = end;
      continue;
    }
    const start = i;
    while (i < bytes.length && !isSymbolBreak(bytes[i])) i++;
    if (i === start) { i++; continue; }
    const text = bytes.subarray(start, i).toString('utf8');
    if (/^\d+\.+$/.test(text)) tokens.push({ type: 'movenum', text, start, end: i });
    else if (/^(?:1-0|0-1|1\/2-1\/2|\*)$/.test(text)) tokens.push({ type: 'result', text, start, end: i });
    else tokens.push({ type: 'san', text, start, end: i });
  }
  return tokens;
}

function splitGames(tokens) {
  const games = [];
  let current = null;
  for (const token of tokens) {
    if (token.type === 'tag') {
      if (!current || current.movetext.length > 0) {
        current = { tags: [], movetext: [] };
        games.push(current);
      }
      current.tags.push(token);
    } else {
      if (!current) {
        current = { tags: [], movetext: [] };
        games.push(current);
      }
      current.movetext.push(token);
    }
  }
  return games;
}

function locate(start, end) {
  return 'byte:' + start + '-' + end;
}

// 从 index 起跳过当前行剩余范围（含嵌套变化），返回继续解释的位置。
function skipLine(tokens, index) {
  let depth = 0;
  let i = index;
  while (i < tokens.length) {
    const type = tokens[i].type;
    if (type === 'open') depth++;
    else if (type === 'close') { if (depth === 0) return i + 1; depth--; }
    else if (type === 'result' && depth === 0) return i + 1;
    i++;
  }
  return i;
}

function attachComment(context, token, state) {
  const ply = context.lastMove ? context.lastMove.ply : context.ply - 1;
  const text = token.text.trim();
  const value = { game: state.gameId, branch: context.branch, ply, text };
  // 注释中的时钟信息只作为来源注解保留原文，不据此推算其他着法的时钟。
  const clock = text.match(/\[%clk\s+([^\]\s]+)\s*\]/);
  if (clock) value.clock = clock[1];
  state.records.push({
    kind: 'comment',
    key: state.scope + '/' + state.gameId + '/' + context.branch + '/' + ply + '/comment@' + token.start,
    value,
    provenance: [{ receiptId: state.receiptId, location: locate(token.start, token.end) }]
  });
}

function attachNag(context, token, state) {
  const ply = context.lastMove ? context.lastMove.ply : context.ply - 1;
  state.records.push({
    kind: 'nag',
    key: state.scope + '/' + state.gameId + '/' + context.branch + '/' + ply + '/nag@' + token.start,
    value: { game: state.gameId, branch: context.branch, ply, nag: token.value },
    provenance: [{ receiptId: state.receiptId, location: locate(token.start, token.end) }]
  });
}

function parseLine(tokens, index, context, state) {
  let i = index;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.type === 'close') return i + 1;
    if (token.type === 'result') return skipLine(tokens, i + 1);
    if (token.type === 'movenum' || token.type === 'unknown') { i++; continue; }
    if (token.type === 'comment') { attachComment(context, token, state); i++; continue; }
    if (token.type === 'nag') { attachNag(context, token, state); i++; continue; }
    if (token.type === 'open') {
      if (!context.lastMove) {
        const end = skipLine(tokens, i + 1);
        state.issues.push({
          reason: 'variation_without_base',
          location: locate(token.start, tokens[end - 1].end),
          game: state.gameId, branch: context.branch, receiptId: state.receiptId
        });
        i = end;
        continue;
      }
      // 变化从被变化着法之前的局面开始，分支名记录来源分歧点。
      const count = (context.variations.get(context.lastMove.ply) || 0) + 1;
      context.variations.set(context.lastMove.ply, count);
      const segment = context.lastMove.moveNumber + context.lastMove.side + ':' + count;
      const child = {
        position: context.lastMove.before,
        ply: context.lastMove.ply,
        branch: context.branch + '/' + segment,
        lastMove: null,
        variations: new Map()
      };
      i = parseLine(tokens, i + 1, child, state);
      continue;
    }
    if (token.type === 'san') {
      let move;
      try {
        move = resolveSAN(context.position, token.text);
      } catch (error) {
        const end = skipLine(tokens, i + 1);
        state.issues.push({
          reason: error.code === 'ambiguous' ? 'ambiguous_move' : error.code === 'invalid' ? 'unrecognized_move' : 'illegal_move',
          location: locate(token.start, tokens[end - 1].end),
          game: state.gameId, branch: context.branch, ply: context.ply, san: token.text,
          receiptId: state.receiptId
        });
        return end;
      }
      state.records.push({
        kind: 'move',
        key: state.scope + '/' + state.gameId + '/' + context.branch + '/' + context.ply,
        value: { game: state.gameId, branch: context.branch, ply: context.ply, san: token.text },
        provenance: [{ receiptId: state.receiptId, location: locate(token.start, token.end) }]
      });
      const before = context.position;
      context.position = applyMove(before, move);
      context.lastMove = { ply: context.ply, before, moveNumber: before.fullmove, side: before.turn };
      context.ply++;
      i++;
      continue;
    }
    i++;
  }
  return i;
}

function interpretGame(game, gameId, state) {
  const tags = {};
  for (const tag of game.tags) tags[tag.name] = tag.value;
  let position;
  if (tags.FEN !== undefined) {
    try {
      position = parseFEN(tags.FEN);
    } catch {
      const tag = game.tags.find(entry => entry.name === 'FEN');
      state.issues.push({
        reason: 'invalid_fen',
        location: locate(tag.start, tag.end),
        game: gameId, fen: tags.FEN, receiptId: state.receiptId
      });
      return;
    }
  } else if (tags.SetUp === '1') {
    const tag = game.tags.find(entry => entry.name === 'SetUp');
    state.issues.push({
      reason: 'setup_without_fen',
      location: locate(tag.start, tag.end),
      game: gameId, receiptId: state.receiptId
    });
    return;
  } else {
    position = initialPosition();
  }
  if (game.tags.length > 0) {
    state.records.push({
      kind: 'game',
      key: state.scope + '/' + gameId,
      value: { game: gameId, tags },
      provenance: [{ receiptId: state.receiptId, location: locate(game.tags[0].start, game.tags[game.tags.length - 1].end) }]
    });
  }
  const context = { position, ply: startPly(position), branch: 'main', lastMove: null, variations: new Map() };
  parseLine(game.movetext, 0, context, { ...state, gameId });
}

// 解释一份 PGN 收件正文，返回结构化记录与问题；game 按文件顺序 g1、g2 区分。
export function interpretPgn(bytes, receiptId) {
  const state = {
    receiptId,
    scope: receiptId.slice(0, 12),
    records: [],
    issues: []
  };
  const games = splitGames(tokenize(bytes));
  games.forEach((game, index) => interpretGame(game, 'g' + (index + 1), state));
  return { records: state.records, issues: state.issues };
}
