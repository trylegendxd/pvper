// server/games/blackjack.js — single-player vs house.
//
// Multi-hand support: a "round" holds the shared deck + dealer cards.
// Each blackjack_hands row references the round so all hands in a deal
// face the SAME dealer (drawn to 17 once, after every player hand is
// resolved). This fixes the previous behaviour where every hand had
// its own dealer.
//
// The shooter/wallet escrow pattern is reused — each hand still owns a
// game_session for ledger purposes, but draws come from the shared
// round's deck.
const { withTx, pool } = require('../db');
const { adjustBalance } = require('../wallet');
const { secureShuffle } = require('../rng');

const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

const MAX_ACTIVE_HANDS = 3;

function newDeck() {
  const cards = [];
  for (const s of SUITS) for (const r of RANKS) cards.push({ r, s });
  return secureShuffle(cards);
}

function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    if (c.r === 'A') { total += 11; aces++; }
    else if (['J','Q','K','10'].includes(c.r)) total += 10;
    else total += Number(c.r);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards) === 21;
}

// ── Public view ───────────────────────────────────────────────────────────
// `dealerCards` and `dealerValue` reflect what this player should SEE.
// The dealer's hole card stays hidden while ANY hand in the round is
// still active. Once the dealer has played, every card is revealed.
function publicViewWithDealer(hand, dealerCards, dealerPlayed, anyHandActive) {
  let visibleCards   = dealerCards;
  let visibleValue   = handValue(dealerCards);
  if (!dealerPlayed && anyHandActive && dealerCards.length >= 2) {
    visibleCards = [dealerCards[0], { hidden: true }];
    visibleValue = handValue([dealerCards[0]]);
  }
  return {
    id:           hand.id,
    roundId:      hand.round_id || null,
    bet:          Number(hand.bet_amount),
    playerCards:  hand.player_cards,
    dealerCards:  visibleCards,
    playerValue:  handValue(hand.player_cards),
    dealerValue:  visibleValue,
    status:       hand.status,
    outcome:      hand.outcome,
    payout:       Number(hand.payout || 0),
  };
}

// Fetch the round + sibling hands for a single hand row, so we can build
// the public view AND know whether to play the dealer.
async function _loadRoundContext(client, hand) {
  if (!hand.round_id) {
    // Legacy single-hand row — fall back to its own deck/dealer_cards.
    return {
      round: null,
      siblings: [hand],
      dealerCards: hand.dealer_cards,
      dealerPlayed: hand.status !== 'active',
    };
  }
  const { rows: rrows } = await client.query(
    `SELECT id, deck, dealer_cards, dealer_played FROM blackjack_rounds WHERE id=$1 FOR UPDATE`,
    [hand.round_id]
  );
  const round = rrows[0];
  const { rows: sibs } = await client.query(
    `SELECT * FROM blackjack_hands WHERE round_id=$1 ORDER BY created_at ASC`,
    [hand.round_id]
  );
  return {
    round,
    siblings: sibs,
    dealerCards: round.dealer_cards,
    dealerPlayed: round.dealer_played,
  };
}

// Build a public view of a hand using the round's shared dealer.
async function _viewWithRound(client, hand) {
  const ctx = await _loadRoundContext(client, hand);
  const anyActive = ctx.siblings.some(s => s.status === 'active');
  return publicViewWithDealer(hand, ctx.dealerCards, ctx.dealerPlayed, anyActive);
}

// Build views for EVERY hand in the round, ordered by creation. This is
// what the action endpoints return so the client can refresh sibling
// hands that got settled when the dealer played (otherwise, standing on
// the last active hand would settle the others server-side but leave
// them stale on the client until a page reload).
async function _allRoundViews(client, hand) {
  const ctx = await _loadRoundContext(client, hand);
  const anyActive = ctx.siblings.some(s => s.status === 'active');
  return ctx.siblings.map(h =>
    publicViewWithDealer(h, ctx.dealerCards, ctx.dealerPlayed, anyActive)
  );
}

// ── Multi-hand start ──────────────────────────────────────────────────────
// Atomically: validates count + balance, opens game_sessions, deducts bets,
// shuffles ONE deck, deals 2 cards to each hand and 2 to the shared dealer,
// then resolves blackjacks immediately. Returns the public view per hand.
async function startBatch(userId, bets) {
  if (!Array.isArray(bets) || bets.length === 0) throw new Error('invalid_bet_amount');
  if (bets.length > MAX_ACTIVE_HANDS) throw new Error('too_many_hands');
  const cleanBets = bets.map(b => Math.floor(Number(b)));
  if (cleanBets.some(b => !Number.isFinite(b) || b <= 0)) throw new Error('invalid_bet_amount');

  return withTx(async (client) => {
    // No active hands allowed in parallel with a new deal (UX simplicity).
    const active = await client.query(
      `SELECT COUNT(*)::int AS n FROM blackjack_hands WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );
    if ((active.rows[0]?.n || 0) > 0) throw new Error('hand_already_active');

    // Shared shoe + dealer for this round.
    let deck = newDeck();
    const playerHands = cleanBets.map(() => [deck.pop(), deck.pop()]);
    const dealerCards = [deck.pop(), deck.pop()];

    // Will the dealer immediately decide blackjacks? Determine here so
    // we only flip dealer_played to true if every hand finishes on deal.
    const dealerBJ = isBlackjack(dealerCards);

    // Each hand's outcome on deal.
    const handStates = playerHands.map((pc, i) => {
      const bet = cleanBets[i];
      const pBJ = isBlackjack(pc);
      let status  = 'active';
      let outcome = null;
      let payout  = 0;
      if (pBJ && dealerBJ)      { status = 'push';             outcome = 'push';     payout = bet; }
      else if (pBJ)             { status = 'player_blackjack'; outcome = 'blackjack';payout = Math.floor(bet * 2.5); }
      else if (dealerBJ)        { status = 'lost';             outcome = 'lose';     payout = 0; }
      return { bet, cards: pc, status, outcome, payout };
    });

    // Create the round.
    const { rows: rrows } = await client.query(
      `INSERT INTO blackjack_rounds (user_id, deck, dealer_cards, dealer_played)
       VALUES ($1, $2::jsonb, $3::jsonb, $4)
       RETURNING id`,
      [userId, JSON.stringify(deck), JSON.stringify(dealerCards), dealerBJ]
    );
    const roundId = rrows[0].id;

    // Create a game_session + blackjack_hands row per seat and deduct bets.
    const handIds = [];
    for (let i = 0; i < handStates.length; i++) {
      const hs = handStates[i];
      const { rows: gs } = await client.query(
        `INSERT INTO game_sessions (game_type, status, bet_amount, pot_amount)
         VALUES ('blackjack','active',$1,$1)
         RETURNING id`,
        [hs.bet]
      );
      const sessionId = gs[0].id;
      await adjustBalance(userId, -hs.bet, 'bet', {
        refType: 'blackjack', refId: sessionId, client,
      });
      const { rows: hrows } = await client.query(
        `INSERT INTO blackjack_hands
           (session_id, user_id, bet_amount, deck, player_cards, dealer_cards,
            status, outcome, payout, round_id, finished_at)
         VALUES ($1,$2,$3,'[]'::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8,$9,
                 CASE WHEN $6 = 'active' THEN NULL ELSE NOW() END)
         RETURNING *`,
        [sessionId, userId, hs.bet,
         JSON.stringify(hs.cards), JSON.stringify(dealerCards),
         hs.status, hs.outcome, hs.payout, roundId]
      );
      handIds.push(hrows[0].id);

      if (hs.payout > 0) {
        const reason = hs.outcome === 'push' ? 'refund' : 'blackjack_payout';
        await adjustBalance(userId, hs.payout, reason, {
          refType: 'blackjack', refId: sessionId, client,
          metadata: { outcome: hs.outcome },
        });
      }
      if (hs.status !== 'active') {
        await client.query(
          `UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`,
          [sessionId]
        );
      }
    }

    // Return public views.
    const { rows: freshHands } = await client.query(
      `SELECT * FROM blackjack_hands WHERE round_id = $1 ORDER BY created_at ASC`,
      [roundId]
    );
    const result = [];
    for (const h of freshHands) result.push(await _viewWithRound(client, h));
    return result;
  });
}

// Back-compat: single-hand wrapper.
async function start(userId, betAmount) {
  const arr = await startBatch(userId, [betAmount]);
  return arr[0];
}

// ── Hit ───────────────────────────────────────────────────────────────────
async function hit(userId, handId) {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM blackjack_hands WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [handId, userId]
    );
    if (!rows.length) throw new Error('hand_not_found');
    const hand = rows[0];
    if (hand.status !== 'active') throw new Error('hand_not_active');

    const { round } = await _loadRoundContext(client, hand);
    // Draw a card from the shared shoe (or the legacy hand-local deck).
    let deck = round ? round.deck.slice() : hand.deck.slice();
    const card = deck.pop();
    const player = hand.player_cards.slice();
    player.push(card);
    const pv = handValue(player);

    let status = 'active', outcome = null;
    if (pv > 21) { status = 'player_bust'; outcome = 'lose'; }

    if (round) {
      await client.query(
        `UPDATE blackjack_rounds SET deck=$1::jsonb WHERE id=$2`,
        [JSON.stringify(deck), round.id]
      );
    }
    await client.query(
      `UPDATE blackjack_hands
          SET deck=$1::jsonb, player_cards=$2::jsonb, status=$3, outcome=$4,
              finished_at = CASE WHEN $3 = 'active' THEN NULL ELSE NOW() END
        WHERE id=$5`,
      [JSON.stringify(round ? [] : deck), JSON.stringify(player), status, outcome, handId]
    );
    if (status !== 'active') {
      await client.query(`UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`, [hand.session_id]);
      await _maybePlayDealer(client, hand, round);
    }

    const fresh = (await client.query(`SELECT * FROM blackjack_hands WHERE id=$1`, [handId])).rows[0];
    const handView  = await _viewWithRound(client, fresh);
    const handViews = await _allRoundViews(client, fresh);
    return { hand: handView, hands: handViews };
  });
}

// ── Stand ─────────────────────────────────────────────────────────────────
async function stand(userId, handId) {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM blackjack_hands WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [handId, userId]
    );
    if (!rows.length) throw new Error('hand_not_found');
    const hand = rows[0];
    if (hand.status !== 'active') throw new Error('hand_not_active');

    await client.query(
      `UPDATE blackjack_hands SET status='player_stand' WHERE id=$1`,
      [handId]
    );

    const { round } = await _loadRoundContext(client, hand);
    await _maybePlayDealer(client, hand, round);

    const fresh = (await client.query(`SELECT * FROM blackjack_hands WHERE id=$1`, [handId])).rows[0];
    const handView  = await _viewWithRound(client, fresh);
    const handViews = await _allRoundViews(client, fresh);
    return { hand: handView, hands: handViews };
  });
}

// ── Double down ───────────────────────────────────────────────────────────
async function doubleDown(userId, handId) {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM blackjack_hands WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [handId, userId]
    );
    if (!rows.length) throw new Error('hand_not_found');
    const hand = rows[0];
    if (hand.status !== 'active') throw new Error('hand_not_active');
    if (hand.player_cards.length !== 2) throw new Error('double_only_on_first_two');

    const extra = Number(hand.bet_amount);
    await adjustBalance(userId, -extra, 'bet', {
      refType: 'blackjack', refId: hand.session_id + ':double', client,
    });

    const { round } = await _loadRoundContext(client, hand);
    let deck = round ? round.deck.slice() : hand.deck.slice();
    const player = hand.player_cards.slice();
    player.push(deck.pop());
    const newBet = Number(hand.bet_amount) * 2;
    const pv = handValue(player);

    let status, outcome;
    if (pv > 21) { status = 'player_bust'; outcome = 'lose'; }
    else         { status = 'player_stand'; outcome = null; }

    if (round) {
      await client.query(
        `UPDATE blackjack_rounds SET deck=$1::jsonb WHERE id=$2`,
        [JSON.stringify(deck), round.id]
      );
    }
    await client.query(
      `UPDATE blackjack_hands
          SET deck=$1::jsonb, player_cards=$2::jsonb, bet_amount=$3,
              status=$4, outcome=$5,
              finished_at = CASE WHEN $4 = 'active' THEN NULL ELSE NOW() END
        WHERE id=$6`,
      [JSON.stringify(round ? [] : deck), JSON.stringify(player), newBet, status, outcome, handId]
    );
    await client.query(`UPDATE game_sessions SET bet_amount=$1 WHERE id=$2`, [newBet, hand.session_id]);
    if (status !== 'active') {
      await client.query(`UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`, [hand.session_id]);
    }
    await _maybePlayDealer(client, hand, round);

    const fresh = (await client.query(`SELECT * FROM blackjack_hands WHERE id=$1`, [handId])).rows[0];
    const handView  = await _viewWithRound(client, fresh);
    const handViews = await _allRoundViews(client, fresh);
    return { hand: handView, hands: handViews };
  });
}

// ── Dealer plays once when no hand is still 'active' ─────────────────────
async function _maybePlayDealer(client, hand, round) {
  if (!round) {
    // Legacy single-hand path — play dealer immediately if the hand has
    // stood/doubled (not busted), then settle.
    const { rows } = await client.query(
      `SELECT * FROM blackjack_hands WHERE id=$1`, [hand.id]
    );
    const fresh = rows[0];
    if (fresh.status === 'player_stand') {
      const deck = fresh.deck.slice();
      const dealer = fresh.dealer_cards.slice();
      while (handValue(dealer) < 17) dealer.push(deck.pop());
      await _settleHandLegacy(client, fresh, dealer);
    }
    return;
  }

  // Are any hands in this round still active?
  const { rows: actives } = await client.query(
    `SELECT 1 FROM blackjack_hands WHERE round_id=$1 AND status='active' LIMIT 1`,
    [round.id]
  );
  if (actives.length) return; // wait for the player to finish other hands

  // Has the dealer already played?
  const { rows: rrows } = await client.query(
    `SELECT * FROM blackjack_rounds WHERE id=$1 FOR UPDATE`, [round.id]
  );
  const r = rrows[0];
  if (r.dealer_played) return;

  // Draw to 17.
  const deck = r.deck.slice();
  const dealer = r.dealer_cards.slice();
  while (handValue(dealer) < 17) dealer.push(deck.pop());
  await client.query(
    `UPDATE blackjack_rounds
        SET deck=$1::jsonb, dealer_cards=$2::jsonb, dealer_played=TRUE, finished_at=NOW()
      WHERE id=$3`,
    [JSON.stringify(deck), JSON.stringify(dealer), round.id]
  );

  // Settle every non-active hand against the SAME dealer.
  const { rows: hands } = await client.query(
    `SELECT * FROM blackjack_hands WHERE round_id=$1`, [round.id]
  );
  const dv = handValue(dealer);
  for (const h of hands) {
    // Skip already-settled outcomes (bust, blackjack at deal, etc.)
    if (h.status === 'player_bust' || h.status === 'player_blackjack' ||
        h.status === 'push'        || h.status === 'won'  || h.status === 'lost') {
      continue;
    }
    const pv = handValue(h.player_cards);
    let status, outcome, payout = 0;
    const bet = Number(h.bet_amount);
    if (dv > 21 || pv > dv)      { status = 'won';  outcome = 'win';  payout = bet * 2; }
    else if (pv === dv)          { status = 'push'; outcome = 'push'; payout = bet; }
    else                         { status = 'lost'; outcome = 'lose'; payout = 0; }

    await client.query(
      `UPDATE blackjack_hands
          SET status=$1, outcome=$2, payout=$3, dealer_cards=$4::jsonb, finished_at=NOW()
        WHERE id=$5`,
      [status, outcome, payout, JSON.stringify(dealer), h.id]
    );
    await client.query(`UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`, [h.session_id]);
    if (payout > 0) {
      const reason = outcome === 'push' ? 'refund' : 'blackjack_payout';
      try {
        await adjustBalance(h.user_id, payout, reason, {
          refType: 'blackjack', refId: h.session_id, client,
          metadata: { outcome, dv, pv },
        });
      } catch (e) {
        if (e.message !== 'duplicate_transaction') throw e;
      }
    }
  }
}

// Legacy settle for old-style hands without a round.
async function _settleHandLegacy(client, hand, dealer) {
  const pv = handValue(hand.player_cards);
  const dv = handValue(dealer);
  let status, outcome, payout = 0;
  const bet = Number(hand.bet_amount);
  if (dv > 21 || pv > dv)      { status = 'won';  outcome = 'win';  payout = bet * 2; }
  else if (pv === dv)          { status = 'push'; outcome = 'push'; payout = bet; }
  else                         { status = 'lost'; outcome = 'lose'; payout = 0; }
  await client.query(
    `UPDATE blackjack_hands
        SET dealer_cards=$1::jsonb, status=$2, outcome=$3, payout=$4, finished_at=NOW()
      WHERE id=$5`,
    [JSON.stringify(dealer), status, outcome, payout, hand.id]
  );
  await client.query(`UPDATE game_sessions SET status='finished', finished_at=NOW() WHERE id=$1`, [hand.session_id]);
  if (payout > 0) {
    const reason = outcome === 'push' ? 'refund' : 'blackjack_payout';
    try {
      await adjustBalance(hand.user_id, payout, reason, {
        refType: 'blackjack', refId: hand.session_id, client, metadata: { outcome, dv, pv },
      });
    } catch (e) { if (e.message !== 'duplicate_transaction') throw e; }
  }
}

// ── Active hands ──────────────────────────────────────────────────────────
async function getActive(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM blackjack_hands
      WHERE user_id = $1 AND status = 'active'
   ORDER BY created_at ASC
      LIMIT $2`,
    [userId, MAX_ACTIVE_HANDS]
  );
  if (!rows.length) return [];
  return Promise.all(rows.map(async (r) => {
    // Build view using the round dealer when available.
    const ctx = await _loadRoundContext(pool, r);
    const anyActive = ctx.siblings.some(s => s.status === 'active');
    return publicViewWithDealer(r, ctx.dealerCards, ctx.dealerPlayed, anyActive);
  }));
}

module.exports = { start, startBatch, hit, stand, doubleDown, getActive, MAX_ACTIVE_HANDS };
