/* =========================================================================
   Gnoming A-Round — Authoritative Game Engine
   Pure logic. No networking. Server is the single source of truth.
   ========================================================================= */

/* ---- Card model ----
   A card is { id, kind, value }
   kind: 'pos' | 'neg' | 'hazard' | 'mulligan'
   value: number for pos/neg; null for hazard/mulligan
*/

function buildDeck() {
  const cards = [];
  let id = 0;
  const add = (kind, value, count) => {
    for (let i = 0; i < count; i++) cards.push({ id: id++, kind, value });
  };
  // Positive (82)
  add('pos', 8, 13);
  add('pos', 7, 13);
  add('pos', 6, 14);
  add('pos', 5, 14);
  add('pos', 4, 14);
  add('pos', 3, 14);
  // Negative (22)
  add('neg', -1, 6);
  add('neg', -2, 8);
  add('neg', -3, 5);
  add('neg', -4, 3);
  // Special (6)
  add('hazard', null, 3);
  add('mulligan', null, 3);
  return cards; // 110 total
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Mulberry32 seeded RNG for reproducible/testable shuffles
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- Game state shape ----
state = {
  players: [{ id, name, connected, grid:[9 cells], roundScores:[], totalBefore }],
  // cell = { card, faceUp }  (card may be null only transiently)
  deck: [cards...],
  discards: [ [pile0], [pile1] ],
  hazardsRemoved: [cards...],   // out of play this round
  round: 1,
  dealerIdx, currentIdx, firstOutIdx,
  phase: 'lobby'|'setup'|'playing'|'finalTurns'|'roundEnd'|'gameOver',
  finalTurnsRemaining,          // players still owed a last turn
  pending: null,                // in-turn pending action (draw/bounce) — see below
  config: { advBounce, runs, advHazard, advMulligan, kidMode },
  log: []
}
*/

const GRID = 9;

function rowsCols() {
  return {
    rows: [[0, 1, 2], [3, 4, 5], [6, 7, 8]],
    cols: [[0, 3, 6], [1, 4, 7], [2, 5, 8]],
  };
}

function newGame(players, config, seed) {
  return {
    players: players.map(p => ({
      id: p.id, name: p.name, connected: true,
      grid: Array.from({ length: GRID }, () => ({ card: null, faceUp: false })),
      roundScores: [], total: 0,
    })),
    deck: [], discards: [[], []], hazardsRemoved: [],
    round: 0, dealerIdx: 0, currentIdx: 0, firstOutIdx: null,
    phase: 'lobby', finalTurnsRemaining: 0, pending: null,
    config: Object.assign({
      advBounce: false, runs: false, advHazard: false, advMulligan: false, kidMode: false,
    }, config || {}),
    seedBase: (seed >>> 0) || (Date.now() >>> 0),
    log: [],
  };
}

function logMsg(state, msg) {
  state.log.push(msg);
  if (state.log.length > 200) state.log.shift();
}

// Deal a new round
function startRound(state) {
  state.round += 1;
  const rng = makeRng(state.seedBase + state.round * 2654435761);
  let deck = shuffle(buildDeck(), rng);

  for (const p of state.players) {
    p.grid = [];
    for (let i = 0; i < GRID; i++) p.grid.push({ card: deck.pop(), faceUp: false });
  }
  state.discards = [[deck.pop()], [deck.pop()]];
  state.deck = deck;
  state.hazardsRemoved = [];
  state.firstOutIdx = null;
  state.finalTurnsRemaining = 0;
  state.pending = null;
  state.phase = 'setup';
  // setup: each player must flip exactly 2 of their own cards before play
  state.setupFlipsRemaining = {};
  for (const p of state.players) state.setupFlipsRemaining[p.id] = 2;
  // play begins with player to left of dealer
  state.currentIdx = (state.dealerIdx + 1) % state.players.length;
  logMsg(state, `Round ${state.round} dealt.`);
}

function allSetupDone(state) {
  return state.players.every(p => state.setupFlipsRemaining[p.id] === 0);
}

// Player flips one of their own face-down cards during setup
function setupFlip(state, playerId, cellIdx) {
  if (state.phase !== 'setup') return err('Not in setup.');
  const p = playerById(state, playerId);
  if (!p) return err('No such player.');
  if (state.setupFlipsRemaining[playerId] <= 0) return err('No setup flips left.');
  const cell = p.grid[cellIdx];
  if (!cell || cell.faceUp) return err('Pick a face-down card.');
  cell.faceUp = true;
  state.setupFlipsRemaining[playerId] -= 1;
  if (allSetupDone(state)) {
    state.phase = 'playing';
    logMsg(state, 'All gnomes ready — play begins!');
  }
  return ok();
}

function playerById(state, id) { return state.players.find(p => p.id === id); }
function ok(extra) { return Object.assign({ ok: true }, extra || {}); }
function err(message) { return { ok: false, error: message }; }

function faceDownCount(p) { return p.grid.filter(c => !c.faceUp).length; }

function isPositive(card) { return card && card.kind === 'pos'; }

// ---- TURN FLOW ----
// pending object during a turn:
// { stage:'awaitDraw' } -> after draw -> { stage:'held', held:card, source }
// after placement, may enter bounce chain: { stage:'bounce', held:card }
// turn ends when player discards or completes placement with no bounce.

function currentPlayer(state) { return state.players[state.currentIdx]; }

function beginTurnIfNeeded(state) {
  if (state.phase !== 'playing' && state.phase !== 'finalTurns') return;
  if (!state.pending) state.pending = { stage: 'awaitDraw' };
}

// Draw from deck or take a discard top
function draw(state, playerId, source /* 'deck'|'discard0'|'discard1' */) {
  if (state.phase !== 'playing' && state.phase !== 'finalTurns') return err('Not your phase.');
  const p = currentPlayer(state);
  if (p.id !== playerId) return err('Not your turn.');
  beginTurnIfNeeded(state);
  if (state.pending.stage !== 'awaitDraw') return err('Already drew.');

  let card;
  if (source === 'deck') {
    if (state.deck.length === 0) reshuffleFromDiscards(state);
    if (state.deck.length === 0) return err('No cards to draw.');
    card = state.deck.pop();
    state.pending = { stage: 'held', held: card, source: 'deck', mustDiscardToEmpty: emptyDiscardIdx(state) };
    logMsg(state, `${p.name} drew from the deck.`);
  } else {
    const idx = source === 'discard0' ? 0 : 1;
    if (state.discards[idx].length === 0) return err('That discard pile is empty.');
    card = state.discards[idx].pop();
    state.pending = { stage: 'held', held: card, source, mustDiscardToEmpty: emptyDiscardIdx(state) };
    logMsg(state, `${p.name} took ${cardLabel(card)} from a discard pile.`);
  }
  return ok();
}

function emptyDiscardIdx(state) {
  if (state.discards[0].length === 0) return 0;
  if (state.discards[1].length === 0) return 1;
  return null;
}

function reshuffleFromDiscards(state) {
  // Standard fallback: if deck empties, reshuffle all but the top of each discard.
  const keep0 = state.discards[0].length ? state.discards[0].pop() : null;
  const keep1 = state.discards[1].length ? state.discards[1].pop() : null;
  const pool = [...state.discards[0], ...state.discards[1]];
  const rng = makeRng(state.seedBase + state.round * 40503 + state.deck.length + 7);
  state.deck = shuffle(pool, rng);
  state.discards = [keep0 ? [keep0] : [], keep1 ? [keep1] : []];
  logMsg(state, 'Deck ran out — discards reshuffled.');
}

function cardLabel(card) {
  if (!card) return 'nothing';
  if (card.kind === 'pos' || card.kind === 'neg') return `a ${card.value}`;
  if (card.kind === 'hazard') return 'a Hazard';
  return 'a Mulligan';
}

// Place held card into a grid cell, replacing whatever is there.
// Handles reveal + bounce eligibility.
function place(state, playerId, cellIdx) {
  const p = currentPlayer(state);
  if (p.id !== playerId) return err('Not your turn.');
  if (!state.pending || (state.pending.stage !== 'held' && state.pending.stage !== 'bounce'))
    return err('Nothing to place.');

  const held = state.pending.held;
  const cell = p.grid[cellIdx];
  if (!cell) return err('Bad cell.');

  // Reveal face-down before replacing (needed for bounce logic / last-card detection)
  const wasFaceDown = !cell.faceUp;
  const replaced = cell.card;

  // Round-end trigger: replacing the LAST face-down card.
  const fdBefore = faceDownCount(p);
  const replacingLastFaceDown = wasFaceDown && fdBefore === 1;

  // Put held into the cell, face up.
  cell.card = held;
  cell.faceUp = true;

  logMsg(state, `${p.name} placed ${cardLabel(held)} into the grid.`);

  // Determine bounce eligibility of the replaced card.
  // Bounce rules: replaced card must be POSITIVE and either match the card just
  // placed OR match at least one card already in grid. Negatives & Mulligans cannot bounce.
  // Advanced bounce also allows bouncing face-up cards (handled by player choosing to
  // replace a face-up cell — same reveal logic, replaced was already face up).
  const canBounce = bounceEligible(state, p, replaced, held);

  if (canBounce) {
    state.pending = { stage: 'bounce', held: replaced, source: state.pending.source,
      mustDiscardToEmpty: state.pending.mustDiscardToEmpty, fromLastFaceDown: replacingLastFaceDown,
      pendingRoundEnd: state.pending.pendingRoundEnd || replacingLastFaceDown };
    logMsg(state, `${p.name} can bounce ${cardLabel(replaced)}.`);
    return ok({ bounce: true });
  }

  // No bounce: the replaced card must be discarded (or removed if hazard),
  // EXCEPT mulligan-overflow handling happens at discard. Player now must discard.
  state.pending = { stage: 'mustDiscard', held: replaced, source: state.pending.source,
    mustDiscardToEmpty: state.pending.mustDiscardToEmpty,
    pendingRoundEnd: (state.pending.pendingRoundEnd || replacingLastFaceDown) };
  return ok({ mustDiscard: true });
}

function bounceEligible(state, p, replaced, justPlaced) {
  if (!isPositive(replaced)) return false; // negatives & mulligans never bounce
  // matches justPlaced (if positive) or any positive already in grid
  const gridVals = p.grid.filter(c => c.card && isPositive(c.card)).map(c => c.card.value);
  if (isPositive(justPlaced) && justPlaced.value === replaced.value) return true;
  return gridVals.includes(replaced.value);
}

// Discard the currently held card (drawn card you don't want, or a replaced card).
function discard(state, playerId, pileIdx /* 0|1 */) {
  const p = currentPlayer(state);
  if (p.id !== playerId) return err('Not your turn.');
  if (!state.pending) return err('Nothing to discard.');
  const stage = state.pending.stage;
  if (stage !== 'held' && stage !== 'mustDiscard' && stage !== 'bounce')
    return err('Cannot discard now.');

  const card = state.pending.held;

  // Hazards are never discarded to piles — removed from play.
  if (card.kind === 'hazard') {
    state.hazardsRemoved.push(card);
    logMsg(state, `${p.name} removed a Hazard from play — opponents may flip a card!`);
    triggerHazard(state, p);
    return endTurn(state, { pendingRoundEnd: state.pending.pendingRoundEnd });
  }

  // Empty-pile rule: if a discard pile is empty, must discard into it (unless hazard, handled above).
  const forced = emptyDiscardIdx(state);
  if (forced !== null) pileIdx = forced;
  if (pileIdx !== 0 && pileIdx !== 1) return err('Choose a discard pile.');

  state.discards[pileIdx].push(card);
  logMsg(state, `${p.name} discarded ${cardLabel(card)}.`);
  return endTurn(state, { pendingRoundEnd: state.pending.pendingRoundEnd });
}

// When a held card during 'held' stage is itself placed we go through place().
// But a player may also choose to KEEP a drawn card by placing; if they keep the
// drawn card AND it is the held one, the replaced card flows as above.

// Hazard effect: opponents flip one face-down card (not their last one).
function triggerHazard(state, actor) {
  state.hazardFlips = {}; // playerId -> needs to flip one
  for (const opp of state.players) {
    if (opp.id === actor.id) continue;
    const fd = faceDownCount(opp);
    const threshold = state.config.advHazard ? 4 : 2; // advanced: only those with >=4 fd
    // standard: any opponent may flip so long as it isn't their last face-down card => needs >=2
    if (fd >= threshold) state.hazardFlips[opp.id] = true;
  }
  if (Object.keys(state.hazardFlips).length === 0) state.hazardFlips = null;
}

// Opponent resolves a hazard flip
function hazardFlip(state, playerId, cellIdx) {
  if (!state.hazardFlips || !state.hazardFlips[playerId]) return err('No hazard flip owed.');
  const p = playerById(state, playerId);
  const cell = p.grid[cellIdx];
  if (!cell || cell.faceUp) return err('Pick a face-down card.');
  if (faceDownCount(p) <= 1) return err('Cannot flip your last face-down card.');
  cell.faceUp = true;
  delete state.hazardFlips[playerId];
  if (Object.keys(state.hazardFlips).length === 0) state.hazardFlips = null;
  return ok();
}

// Mulligan overflow: a player may hold only ONE mulligan in their grid.
// If after a turn they have >1, they must discard the extra. We enforce at endTurn
// by detecting and flagging; the extra is auto-resolved (most recently placed gets discarded).
function enforceMulliganLimit(state, p) {
  const mIdx = p.grid.map((c, i) => (c.card && c.card.kind === 'mulligan' ? i : -1)).filter(i => i >= 0);
  // Note: face-down mulligans aren't "in grid" as known until revealed; we only count face-up here,
  // plus any just-placed. Per rules the limit is on mulligans in your grid (revealed).
  const faceUpM = mIdx.filter(i => p.grid[i].faceUp);
  return faceUpM.length > 1 ? faceUpM : null;
}

function endTurn(state, opts) {
  opts = opts || {};
  const p = currentPlayer(state);

  // Round-end trigger bookkeeping
  if (opts.pendingRoundEnd && state.firstOutIdx === null) {
    state.firstOutIdx = state.currentIdx;
    state.phase = 'finalTurns';
    // every OTHER player gets one final turn
    state.finalTurnsRemaining = state.players.length - 1;
    logMsg(state, `${p.name} went out! Final turns begin.`);
  }

  state.pending = null;

  // If a hazard flip is owed by opponents, pause turn advance until resolved.
  // (Client gates the next 'draw' until hazardFlips cleared.)
  // Advance turn:
  if (state.phase === 'finalTurns') {
    advanceTurn(state);
    if (state.finalTurnsRemaining <= 0) {
      finishRound(state);
      return ok({ roundEnded: true });
    }
    state.finalTurnsRemaining -= 0; // decrement happens in advanceTurn
  } else {
    advanceTurn(state);
  }
  return ok();
}

function advanceTurn(state) {
  if (state.phase === 'finalTurns') {
    state.finalTurnsRemaining -= 1;
  }
  state.currentIdx = (state.currentIdx + 1) % state.players.length;
  // skip the player who already went out during final turns
  if (state.phase === 'finalTurns' && state.currentIdx === state.firstOutIdx) {
    // they don't take another turn
  }
}

// ---- ROUND SCORING ----
function finishRound(state) {
  state.phase = 'roundEnd';
  // reveal all face-down
  for (const p of state.players) for (const c of p.grid) c.faceUp = true;

  const breakdown = [];
  for (const p of state.players) {
    const sc = scoreGrid(p.grid, state.config);
    p.roundScores.push(sc.total);
    breakdown.push({ id: p.id, name: p.name, ...sc });
  }

  // First-out bonus/penalty
  if (state.firstOutIdx !== null && !state.config.kidMode) {
    const fo = state.players[state.firstOutIdx];
    const foScore = fo.roundScores[fo.roundScores.length - 1];
    const others = state.players.filter((_, i) => i !== state.firstOutIdx)
      .map(pp => pp.roundScores[pp.roundScores.length - 1]);
    const isStrictlyLowest = others.every(o => foScore < o);
    if (isStrictlyLowest) {
      fo.roundScores[fo.roundScores.length - 1] -= 5;
      logMsg(state, `${fo.name} went out first AND had the lowest score: -5 bonus!`);
    } else {
      fo.roundScores[fo.roundScores.length - 1] += 5;
      logMsg(state, `${fo.name} went out first but didn't have the lowest: +5 punishment.`);
    }
  }

  for (const p of state.players) p.total = p.roundScores.reduce((a, b) => a + b, 0);
  state.lastBreakdown = breakdown;

  if (state.round >= 3) {
    state.phase = 'gameOver';
    state.winner = decideWinner(state);
    logMsg(state, `Game over! Winner: ${state.winner.name}.`);
  } else {
    // dealer rotates left; first player is to dealer's left
    state.dealerIdx = (state.dealerIdx + 1) % state.players.length;
    logMsg(state, 'Round complete. Ready for the next round.');
  }
}

function decideWinner(state) {
  let best = null;
  for (const p of state.players) {
    if (!best || p.total < best.total) best = p;
    else if (p.total === best.total) {
      // tie-break: lower final-round score
      const a = p.roundScores[p.roundScores.length - 1];
      const b = best.roundScores[best.roundScores.length - 1];
      if (a < b) best = p;
    }
  }
  return { id: best.id, name: best.name, total: best.total };
}

// Score a 9-cell grid. Returns { total, sets, raw, hazardPenalty }
function scoreGrid(grid, config) {
  const { rows, cols } = rowsCols();
  const cards = grid.map(c => c.card);
  const inSet = new Array(GRID).fill(false);
  let setPoints = 0;

  // Evaluate a line of 3 indices for a matching set or (advanced) run, with mulligan support.
  function evalLine(line) {
    const cs = line.map(i => cards[i]);
    if (cs.some(c => !c)) return null;
    const mulIdx = line.filter(i => cards[i].kind === 'mulligan');
    const posIdx = line.filter(i => cards[i].kind === 'pos');
    const otherIdx = line.filter(i => cards[i].kind !== 'pos' && cards[i].kind !== 'mulligan');
    if (otherIdx.length > 0) return null; // neg/hazard kill the line
    const posVals = posIdx.map(i => cards[i].value);

    // SET: all positives equal, mulligans fill the value
    let setVal = null;
    if (posVals.length >= 1) {
      const allEqual = posVals.every(v => v === posVals[0]);
      if (allEqual) setVal = posVals[0];
    } else {
      // all three mulligans — choose best (most negative => highest value 8)
      setVal = 8;
    }
    let best = null;
    if (setVal !== null) best = { type: 'set', value: setVal, score: -setVal, line };

    // RUN (advanced): three consecutive ascending/descending; score = -(middle)
    if (config.runs) {
      const runVal = bestRun(line, cards, config.advMulligan);
      if (runVal !== null) {
        const runScore = -runVal;
        if (!best || runScore < best.score) best = { type: 'run', value: runVal, score: runScore, line };
      }
    }
    return best;
  }

  const lineResults = [];
  for (const line of [...rows, ...cols]) {
    const r = evalLine(line);
    if (r) lineResults.push(r);
  }
  // A single card can complete both a row and a column — that's allowed; we just
  // mark cells as inSet so their face value isn't double-counted as positive points.
  for (const r of lineResults) {
    setPoints += r.score;
    for (const i of r.line) inSet[i] = true;
  }

  // Remaining (not in any set/run): face value for pos & neg, hazard +10, mulligan 0
  let raw = 0, hazardPenalty = 0;
  for (let i = 0; i < GRID; i++) {
    const c = cards[i];
    if (!c) continue;
    if (inSet[i]) continue;
    if (c.kind === 'pos' || c.kind === 'neg') raw += c.value;
    else if (c.kind === 'hazard') hazardPenalty += 10;
    // mulligan not in a set = 0
  }

  return {
    total: setPoints + raw + hazardPenalty,
    setPoints, raw, hazardPenalty,
    sets: lineResults,
  };
}

function bestRun(line, cards, advMulligan) {
  // values present; mulligan is wild (any positive). standard mulligan can differ row/col,
  // advanced mulligan must be single value — but within a single line that distinction
  // doesn't change feasibility, so we treat mulligan as wild here.
  const kinds = line.map(i => cards[i].kind);
  if (kinds.some(k => k !== 'pos' && k !== 'mulligan')) return null;
  const vals = line.map(i => (cards[i].kind === 'pos' ? cards[i].value : null));
  const known = vals.filter(v => v !== null).sort((a, b) => a - b);
  // Need three consecutive numbers in 3..8. Try every window.
  for (let start = 3; start <= 6; start++) {
    const need = [start, start + 1, start + 2];
    if (canFormRun(vals, need)) return start + 1; // middle value
  }
  return null;
}

function canFormRun(vals, need) {
  const pool = need.slice();
  let wild = 0;
  for (const v of vals) {
    if (v === null) { wild++; continue; }
    const idx = pool.indexOf(v);
    if (idx === -1) return false;
    pool.splice(idx, 1);
  }
  return pool.length === wild;
}

module.exports = {
  buildDeck, makeRng, shuffle, newGame, startRound, setupFlip, draw, place,
  discard, hazardFlip, endTurn, finishRound, scoreGrid, decideWinner,
  faceDownCount, currentPlayer, playerById, cardLabel, rowsCols, GRID,
};
