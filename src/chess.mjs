// 合法着法判定：棋盘状态、FEN 解析、合法走法生成与 SAN 解析。
// 仅用于核对棋谱来源中的着法是否合法、是否含糊，不做任何胜率或棋力计算。

const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_STEPS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const BISHOP_RAYS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK_RAYS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const QUEEN_RAYS = [...BISHOP_RAYS, ...ROOK_RAYS];
const PROMOTION_ORDER = ['q', 'r', 'b', 'n'];

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function onBoard(file, rank) {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

function colorOf(piece) {
  return piece >= 'A' && piece <= 'Z' ? 'w' : 'b';
}

export function parseFEN(fen) {
  const parts = typeof fen === 'string' ? fen.trim().split(/\s+/) : [];
  if (parts.length < 4) throw new Error('invalid_fen');
  const [placement, turn, castling, enPassant, half = '0', full = '1'] = parts;
  const board = new Array(64).fill(null);
  const ranks = placement.split('/');
  if (ranks.length !== 8) throw new Error('invalid_fen');
  for (let row = 0; row < 8; row++) {
    let file = 0;
    for (const char of ranks[row]) {
      if (char >= '1' && char <= '8') file += Number(char);
      else if (/^[pnbrqkPNBRQK]$/.test(char)) { board[(7 - row) * 8 + file] = char; file++; }
      else throw new Error('invalid_fen');
    }
    if (file !== 8) throw new Error('invalid_fen');
  }
  if (turn !== 'w' && turn !== 'b') throw new Error('invalid_fen');
  if (!/^(-|[KQkq]{1,4})$/.test(castling)) throw new Error('invalid_fen');
  let ep = null;
  if (enPassant !== '-') {
    const match = enPassant.match(/^([a-h])([36])$/);
    if (!match) throw new Error('invalid_fen');
    ep = (Number(match[2]) - 1) * 8 + (match[1].charCodeAt(0) - 97);
  }
  const halfmove = Number(half);
  const fullmove = Number(full);
  if (!Number.isInteger(halfmove) || halfmove < 0 || !Number.isInteger(fullmove) || fullmove < 1) {
    throw new Error('invalid_fen');
  }
  return { board, turn, castling: castling === '-' ? '' : castling, ep, halfmove, fullmove };
}

export function initialPosition() {
  return parseFEN(START_FEN);
}

// 该局从初始局面计算的半回合序号：FEN 用它的 fullmove 与 side 确定。
export function startPly(position) {
  return (position.fullmove - 1) * 2 + (position.turn === 'w' ? 1 : 2);
}

export function isAttacked(board, square, bySide) {
  const file = square % 8;
  const rank = (square - file) / 8;
  const pawn = bySide === 'w' ? 'P' : 'p';
  const pawnRank = rank + (bySide === 'w' ? -1 : 1);
  for (const df of [-1, 1]) {
    if (onBoard(file + df, pawnRank) && board[pawnRank * 8 + file + df] === pawn) return true;
  }
  const knight = bySide === 'w' ? 'N' : 'n';
  for (const [df, dr] of KNIGHT_STEPS) {
    if (onBoard(file + df, rank + dr) && board[(rank + dr) * 8 + file + df] === knight) return true;
  }
  const king = bySide === 'w' ? 'K' : 'k';
  for (const [df, dr] of KING_STEPS) {
    if (onBoard(file + df, rank + dr) && board[(rank + dr) * 8 + file + df] === king) return true;
  }
  const bishop = bySide === 'w' ? 'B' : 'b';
  const rook = bySide === 'w' ? 'R' : 'r';
  const queen = bySide === 'w' ? 'Q' : 'q';
  for (const [df, dr] of BISHOP_RAYS) {
    let tf = file + df;
    let tr = rank + dr;
    while (onBoard(tf, tr)) {
      const piece = board[tr * 8 + tf];
      if (piece) { if (piece === bishop || piece === queen) return true; break; }
      tf += df; tr += dr;
    }
  }
  for (const [df, dr] of ROOK_RAYS) {
    let tf = file + df;
    let tr = rank + dr;
    while (onBoard(tf, tr)) {
      const piece = board[tr * 8 + tf];
      if (piece) { if (piece === rook || piece === queen) return true; break; }
      tf += df; tr += dr;
    }
  }
  return false;
}

function pseudoMoves(position) {
  const { board, turn } = position;
  const moves = [];
  const forward = turn === 'w' ? 1 : -1;
  const startRank = turn === 'w' ? 1 : 6;
  const lastRank = turn === 'w' ? 7 : 0;
  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (!piece || colorOf(piece) !== turn) continue;
    const file = from % 8;
    const rank = (from - file) / 8;
    const kind = piece.toLowerCase();
    if (kind === 'p') {
      const oneRank = rank + forward;
      if (onBoard(file, oneRank)) {
        const one = oneRank * 8 + file;
        if (!board[one]) {
          if (oneRank === lastRank) {
            for (const promo of PROMOTION_ORDER) {
              moves.push({ from, to: one, piece, promotion: turn === 'w' ? promo.toUpperCase() : promo });
            }
          } else {
            moves.push({ from, to: one, piece });
          }
          const two = (rank + 2 * forward) * 8 + file;
          if (rank === startRank && !board[two]) moves.push({ from, to: two, piece });
        }
      }
      for (const df of [-1, 1]) {
        const tf = file + df;
        const tr = rank + forward;
        if (!onBoard(tf, tr)) continue;
        const to = tr * 8 + tf;
        const target = board[to];
        if (target && colorOf(target) !== turn) {
          if (tr === lastRank) {
            for (const promo of PROMOTION_ORDER) {
              moves.push({ from, to, piece, promotion: turn === 'w' ? promo.toUpperCase() : promo });
            }
          } else {
            moves.push({ from, to, piece });
          }
        } else if (!target && position.ep === to) {
          moves.push({ from, to, piece, ep: true });
        }
      }
      continue;
    }
    if (kind === 'n' || kind === 'k') {
      for (const [df, dr] of kind === 'n' ? KNIGHT_STEPS : KING_STEPS) {
        const tf = file + df;
        const tr = rank + dr;
        if (!onBoard(tf, tr)) continue;
        const target = board[tr * 8 + tf];
        if (!target || colorOf(target) !== turn) moves.push({ from, to: tr * 8 + tf, piece });
      }
      continue;
    }
    const rays = kind === 'b' ? BISHOP_RAYS : kind === 'r' ? ROOK_RAYS : QUEEN_RAYS;
    for (const [df, dr] of rays) {
      let tf = file + df;
      let tr = rank + dr;
      while (onBoard(tf, tr)) {
        const to = tr * 8 + tf;
        const target = board[to];
        if (!target) moves.push({ from, to, piece });
        else { if (colorOf(target) !== turn) moves.push({ from, to, piece }); break; }
        tf += df; tr += dr;
      }
    }
  }
  const home = turn === 'w' ? 0 : 7;
  const kingFrom = home * 8 + 4;
  const kingPiece = turn === 'w' ? 'K' : 'k';
  const rookPiece = turn === 'w' ? 'R' : 'r';
  const enemy = turn === 'w' ? 'b' : 'w';
  if (board[kingFrom] === kingPiece) {
    if (position.castling.includes(turn === 'w' ? 'K' : 'k') &&
        board[home * 8 + 7] === rookPiece && !board[home * 8 + 5] && !board[home * 8 + 6] &&
        !isAttacked(board, kingFrom, enemy) && !isAttacked(board, home * 8 + 5, enemy) && !isAttacked(board, home * 8 + 6, enemy)) {
      moves.push({ from: kingFrom, to: home * 8 + 6, piece: kingPiece, castle: 'K' });
    }
    if (position.castling.includes(turn === 'w' ? 'Q' : 'q') &&
        board[home * 8] === rookPiece && !board[home * 8 + 1] && !board[home * 8 + 2] && !board[home * 8 + 3] &&
        !isAttacked(board, kingFrom, enemy) && !isAttacked(board, home * 8 + 3, enemy) && !isAttacked(board, home * 8 + 2, enemy)) {
      moves.push({ from: kingFrom, to: home * 8 + 2, piece: kingPiece, castle: 'Q' });
    }
  }
  return moves;
}

export function applyMove(position, move) {
  const board = position.board.slice();
  const piece = board[move.from];
  board[move.from] = null;
  let captured = board[move.to];
  if (move.ep) {
    const capturedSquare = position.turn === 'w' ? move.to - 8 : move.to + 8;
    captured = board[capturedSquare];
    board[capturedSquare] = null;
  }
  board[move.to] = move.promotion || piece;
  if (move.castle) {
    const home = position.turn === 'w' ? 0 : 7;
    if (move.castle === 'K') { board[home * 8 + 5] = board[home * 8 + 7]; board[home * 8 + 7] = null; }
    else { board[home * 8 + 3] = board[home * 8]; board[home * 8] = null; }
  }
  let castling = position.castling;
  if (piece === 'K') castling = castling.replace(/[KQ]/g, '');
  if (piece === 'k') castling = castling.replace(/[kq]/g, '');
  for (const [square, bit] of [[0, 'Q'], [7, 'K'], [56, 'q'], [63, 'k']]) {
    if (move.from === square || move.to === square) castling = castling.replace(bit, '');
  }
  let ep = null;
  if (piece.toLowerCase() === 'p' && Math.abs(move.to - move.from) === 16) ep = (move.to + move.from) / 2;
  const halfmove = piece.toLowerCase() === 'p' || captured ? 0 : position.halfmove + 1;
  const fullmove = position.turn === 'b' ? position.fullmove + 1 : position.fullmove;
  return { board, turn: position.turn === 'w' ? 'b' : 'w', castling, ep, halfmove, fullmove };
}

export function legalMoves(position) {
  const enemy = position.turn === 'w' ? 'b' : 'w';
  const king = position.turn === 'w' ? 'K' : 'k';
  return pseudoMoves(position).filter(move => {
    const next = applyMove(position, move);
    const kingSquare = next.board.indexOf(king);
    return kingSquare !== -1 && !isAttacked(next.board, kingSquare, enemy);
  });
}

// 把 SAN 着法解析为当前局面下的唯一合法走法。
// 失败时抛出带 code 的错误：invalid（无法识别）、illegal（不合法）、ambiguous（含糊）。
export function resolveSAN(position, sanText) {
  const failure = code => Object.assign(new Error('san_' + code), { code });
  const san = String(sanText).trim().replace(/[+#!?]+$/, '');
  if (/^[O0]-[O0](-[O0])?$/.test(san)) {
    const castle = san.length > 3 ? 'Q' : 'K';
    const matches = legalMoves(position).filter(move => move.castle === castle);
    if (matches.length === 0) throw failure('illegal');
    return matches[0];
  }
  const match = san.match(/^([KQRBN])?([a-h])?([1-8])?x?([a-h])([1-8])(?:=?([QRBN]))?$/);
  if (!match) throw failure('invalid');
  const kind = (match[1] || 'P').toLowerCase();
  const hintFile = match[2] ? match[2].charCodeAt(0) - 97 : null;
  const hintRank = match[3] ? Number(match[3]) - 1 : null;
  const to = (Number(match[5]) - 1) * 8 + (match[4].charCodeAt(0) - 97);
  const promotion = match[6] || null;
  const matches = legalMoves(position).filter(move => {
    if (move.piece.toLowerCase() !== kind || move.to !== to) return false;
    if (hintFile !== null && move.from % 8 !== hintFile) return false;
    if (hintRank !== null && (move.from - move.from % 8) / 8 !== hintRank) return false;
    return (move.promotion ? move.promotion.toUpperCase() : null) === promotion;
  });
  if (matches.length === 0) throw failure('illegal');
  if (matches.length > 1) throw failure('ambiguous');
  return matches[0];
}
