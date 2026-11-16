import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretPgn } from '../src/pgn.mjs';

const RECEIPT = 'a'.repeat(64);

function interpret(text) {
  return interpretPgn(Buffer.from(text, 'utf8'), RECEIPT);
}

function moves(records) {
  return records.filter(record => record.kind === 'move').map(record => record.value);
}

test('主线、嵌套变化、注释与 NAG 按棋局上下文归属', () => {
  const text = '[Event "Teaching"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 (2. Bc4 Nf6 (2... Nc6)) Nc6 3. Bb5 $1 {[%clk 0:09:58] note} a6 *\n';
  const { records, issues } = interpret(text);
  assert.deepEqual(issues, []);
  assert.deepEqual(moves(records), [
    { game: 'g1', branch: 'main', ply: 1, san: 'e4' },
    { game: 'g1', branch: 'main', ply: 2, san: 'e5' },
    { game: 'g1', branch: 'main', ply: 3, san: 'Nf3' },
    { game: 'g1', branch: 'main/2w:1', ply: 3, san: 'Bc4' },
    { game: 'g1', branch: 'main/2w:1', ply: 4, san: 'Nf6' },
    { game: 'g1', branch: 'main/2w:1/2b:1', ply: 4, san: 'Nc6' },
    { game: 'g1', branch: 'main', ply: 4, san: 'Nc6' },
    { game: 'g1', branch: 'main', ply: 5, san: 'Bb5' },
    { game: 'g1', branch: 'main', ply: 6, san: 'a6' }
  ]);
  const nag = records.find(record => record.kind === 'nag');
  assert.deepEqual(nag.value, { game: 'g1', branch: 'main', ply: 5, nag: 1 });
  const comment = records.find(record => record.kind === 'comment');
  assert.equal(comment.value.branch, 'main');
  assert.equal(comment.value.ply, 5);
  assert.equal(comment.value.text, '[%clk 0:09:58] note');
  assert.equal(comment.value.clock, '0:09:58');
  const source = Buffer.from(text, 'utf8');
  const nagOrigin = nag.provenance[0];
  assert.equal(nagOrigin.receiptId, RECEIPT);
  assert.equal(source.subarray(...nagOrigin.location.match(/^byte:(\d+)-(\d+)$/).slice(1).map(Number)).toString('utf8'), '$1');
});

test('带 SetUp/FEN 的残局按给定局面与 fullmove/side 计算 ply', () => {
  const text = '[Event "Ending"]\n[SetUp "1"]\n[FEN "8/8/8/8/8/8/4K3/7k w - - 0 1"]\n[Result "*"]\n\n1. Kf3 Kh2 *\n';
  const { records, issues } = interpret(text);
  assert.deepEqual(issues, []);
  assert.deepEqual(moves(records), [
    { game: 'g1', branch: 'main', ply: 1, san: 'Kf3' },
    { game: 'g1', branch: 'main', ply: 2, san: 'Kh2' }
  ]);
});

test('FEN 黑方先行时 ply 由 fullmove 与 side 确定', () => {
  const text = '[SetUp "1"]\n[FEN "7k/8/8/8/8/8/8/4K3 b - - 5 20"]\n\n20... Kg8 21. Kf2 *\n';
  const { records, issues } = interpret(text);
  assert.deepEqual(issues, []);
  assert.deepEqual(moves(records), [
    { game: 'g1', branch: 'main', ply: 40, san: 'Kg8' },
    { game: 'g1', branch: 'main', ply: 41, san: 'Kf2' }
  ]);
});

test('变化中的非法着法记录位置与剩余范围，其余已确认内容仍可查', () => {
  const text = '[Event "Teaching"]\n\n1. e4 e5 2. Nf3 (2. Bh6 Nf6 (2... Nc6)) Nc6 3. Bb5 a6 *\n\n[Event "Ending"]\n[SetUp "1"]\n[FEN "8/8/8/8/8/8/4K3/7k w - - 0 1"]\n\n1. Kf3 Kh2 *\n';
  const { records, issues } = interpret(text);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'illegal_move');
  assert.equal(issues[0].san, 'Bh6');
  assert.equal(issues[0].branch, 'main/2w:1');
  assert.equal(issues[0].receiptId, RECEIPT);
  const range = issues[0].location.match(/^byte:(\d+)-(\d+)$/).slice(1).map(Number);
  const skipped = Buffer.from(text, 'utf8').subarray(range[0], range[1]).toString('utf8');
  assert.ok(skipped.startsWith('Bh6'), '问题位置应指向无法继续解释的着法');
  assert.ok(skipped.endsWith(')'), '剩余范围应覆盖整个无法解释的变化');
  assert.ok(skipped.includes('Nc6'), '嵌套变化随所属分支一并标记');
  assert.deepEqual(moves(records), [
    { game: 'g1', branch: 'main', ply: 1, san: 'e4' },
    { game: 'g1', branch: 'main', ply: 2, san: 'e5' },
    { game: 'g1', branch: 'main', ply: 3, san: 'Nf3' },
    { game: 'g1', branch: 'main', ply: 4, san: 'Nc6' },
    { game: 'g1', branch: 'main', ply: 5, san: 'Bb5' },
    { game: 'g1', branch: 'main', ply: 6, san: 'a6' },
    { game: 'g2', branch: 'main', ply: 1, san: 'Kf3' },
    { game: 'g2', branch: 'main', ply: 2, san: 'Kh2' }
  ]);
});

test('含糊着法无法唯一确定，记录问题且不猜测', () => {
  const text = '[SetUp "1"]\n[FEN "7k/8/8/8/8/3N1N2/8/4K3 w - - 0 1"]\n\n1. Ne5 Kg8 *\n';
  const { records, issues } = interpret(text);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'ambiguous_move');
  assert.equal(issues[0].san, 'Ne5');
  assert.deepEqual(moves(records), []);
});

test('王车易位、升变与吃过路兵按合法规则解释', () => {
  const castling = interpret('[SetUp "1"]\n[FEN "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"]\n\n1. O-O O-O-O *\n');
  assert.deepEqual(castling.issues, []);
  assert.deepEqual(moves(castling.records).map(move => move.san), ['O-O', 'O-O-O']);
  const promotion = interpret('[SetUp "1"]\n[FEN "8/P6k/8/8/8/8/8/4K3 w - - 0 1"]\n\n1. a8=Q *\n');
  assert.deepEqual(promotion.issues, []);
  assert.equal(moves(promotion.records)[0].san, 'a8=Q');
  const enPassant = interpret('1. e4 a6 2. e5 d5 3. exd6 *\n');
  assert.deepEqual(enPassant.issues, []);
  assert.equal(moves(enPassant.records).at(-1).san, 'exd6');
});

test('每个解释结果都能回查真实收件与字节区间', () => {
  const text = '[Event "A"]\n\n1. d4 d5 (1... Nf6) 2. c4 *\n';
  const { records, issues } = interpret(text);
  assert.deepEqual(issues, []);
  const source = Buffer.from(text, 'utf8');
  for (const record of records) {
    assert.ok(record.provenance.length > 0);
    for (const origin of record.provenance) {
      assert.equal(origin.receiptId, RECEIPT);
      const range = origin.location.match(/^byte:(\d+)-(\d+)$/);
      assert.ok(range, '定位应为可复查的字节区间');
      assert.ok(Number(range[2]) > Number(range[1]));
      assert.ok(source.subarray(Number(range[1]), Number(range[2])).length > 0);
    }
  }
  const variation = records.find(record => record.kind === 'move' && record.value.branch === 'main/1b:1');
  assert.deepEqual(variation.value, { game: 'g1', branch: 'main/1b:1', ply: 2, san: 'Nf6' });
});
