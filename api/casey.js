// CasEdge — Casey Simulator server endpoint. Owns the case library AND all
// grading for the BCG Casey game, so answer keys never reach the browser.
//
// Mirrors api/claude.js / api/case-session.js security: locked CORS, Supabase
// bearer verification, shared per-user rate limit, body limits, upstream
// timeout + no error leakage. The library (_casey_cases.json) and every answer
// key (option.correct, answer, validation, answer_explain, model_answer,
// trigger_phrases, rubrics) live ONLY here. The client receives sanitized cases
// (prompts, option TEXT, exhibits — no keys) and, per graded step, a verdict.
//
// Actions:
//   list   → [{id,title,meta_tag}]                    (picker; no spoilers)
//   case   → {id,title,meta_tag,scenario,exhibits,steps:[flattened+sanitized]}
//   grade  → {gid, payload} graded server-side → verdict (+ post-answer explain)

const CASES_DATA = require('./_casey_cases.json');

const FALLBACK_ORIGIN = 'https://cas-edge-final.vercel.app';
const GRADER_MODEL = 'claude-sonnet-5';
const MAX_BODY_BYTES = 200 * 1024;
const RATE_LIMIT = 40;                 // slightly higher: a case has many graded steps
const RATE_WINDOW_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 50 * 1000;
const AUTH_TIMEOUT_MS = 8 * 1000;

/* ───────────────────────── voice grader (server-side) ─────────────────────── */
const CASEY_VOICE_SYSTEM = `You are a strict but fair BCG case-interview examiner. You are given the TRANSCRIPT of a candidate's spoken final recommendation (speech-to-text, so it WILL contain recognition errors: numbers as words, run-together words, "fifty five" for 55, missing punctuation) and a case_id. Grade the transcript against this case's rubric on 4 criteria. Each criterion is strictly pass/fail. Return ONLY JSON.

4 CRITERIA (each binary PASS/FAIL):
1. c1_conclusion_first — an action recommendation in the first 1-2 sentences, with an action verb, in the CORRECT direction (rubric.conclusion / rubric.direction). FAIL if ANY of: (a) the direction is WRONG; (b) CONCLUSION-LAST — the recommendation appears only after a chain of facts/calculations (typically introduced by "so / therefore / thus / meaning / after weighing / conclude that…"), i.e. the first 1-2 sentences carry the reasoning rather than the action itself, even if the final conclusion is correct and well-supported; (c) NAIVE-HEADLINE — rubric.conclusion pins a corrected/honest magnitude and explicitly rejects a naive one (e.g. "…at the honest ~$11.4M, NOT $29M"), and the candidate asserts that rejected naive figure as the benefit — the required correction was not made, so the recommendation does not match rubric.conclusion.
2. c2_anchor_number — an anchor figure IN THE ROLE of justification. >=2 numbers spoken, and >=1 from rubric.anchor_numbers, used to justify the recommendation (tied to the thesis: contribution / breakeven / EV-gap / direction). See Rule 1.
3. c3_risks — >=1 internal AND >=1 external risk (from rubric.internal_examples / rubric.external_examples or a meaningful equivalent), tied to the recommendation; generic "market risks" with no tie-in do not count.
4. c4_nextstep — >=1 concrete, preferably time-bound next step.
score = number of PASSes (0-4). verdict: 4 -> strong, 3 -> ok, <=2 -> weak.

THREE IRON RULES:
RULE 1 — anchor by MEANING, not by substring. c2 passes ONLY if the figure justifies the decision, not merely if it is spoken. FAIL if: (a) two random off-point numbers are named (raw base size / prices / volume); (b) the correct figure is spoken INSIDE a wrong conclusion. Hard link: if c1 FAILs due to a wrong direction, c2 CANNOT pass. Distinguish the ANCHOR (contribution, net-impact, breakeven, gap, multiple) from RAW size (subscribers / units / price / volume), even when they coincide numerically. Credit only the qualified form (rubric.anchor_numbers are written that way) — match the meaning, not the bare figure.
RULE 2 — clean_special (C6, C15, C19, C25, C35, C45, C57). In clean cases the correct answer is to CONFIRM that there is NO reversal. If the candidate "finds" an invented reversal (cannibalization / spillover / network-effect / reversal that is NOT in the data) and recommends the OPPOSITE, then c1 FAIL AND c2 FAIL. The flag rubric.clean_special=true turns on this logic.
RULE 3 — robustness to ASR. Normalize numbers from speech ("fifty five and a half thousand"=55,500, "one point four million"=1.4M, "minus twelve hundred"=-1,200). Roundings within +/-2% of an anchor count. rubric.transcription_variants are ASR forms of the anchors. Use the case CONTEXT to tell similar numbers apart (0.38% vs 38%, $4.13 vs 4.13c, "40,000 a month" vs "40,000 subscribers") — check against the meaning of the phrase, not the bare figure.

Do NOT penalize: accent, grammar, fillers, length, style. Penalize ONLY for missing required content. Do not add requirements beyond the 4 criteria.

RESPONSE FORMAT (strict JSON, no preamble, no markdown):
{"case_id":"Cxx","criteria":{"c1_conclusion_first":{"pass":true,"evidence":"quote"},"c2_anchor_number":{"pass":true,"evidence":"quote"},"c3_risks":{"pass":true,"evidence":"quote"},"c4_nextstep":{"pass":true,"evidence":"quote"}},"score":4,"verdict":"strong","coaching":"1-3 sentences IN ENGLISH: what passed, what failed, how to fix. Specific, no platitudes."}
Always return an evidence quote (even if approximate) from the transcript for each criterion. All prose (evidence, coaching) MUST be in English.`;

const CASEY_RUBRICS = {
  "C1":  {"conclusion":"keep Valtona + add Herdal top-up (hybrid); NOT full move","anchor_numbers":["55,500","52,000-vs-55,000"],"mechanisms_required":["cost advantage kept + insurance against shortfall"],"internal_examples":["two-site quality/consistency"],"external_examples":["Valtona deviation/contract, excise"]},
  "C2":  {"conclusion":"run promo WITH the 500-unit cap (not uncapped, not reject)","anchor_numbers":["27,500","9,500-vs-87,500","33.65%"],"mechanisms_required":["expected refund cost overstated the gain; cap limits exposure"],"internal_examples":["cap communication/backlash"],"external_examples":["consumer-protection regulation; probability drift past breakeven"]},
  "C3":  {"conclusion":"keep the kit (± reprice); NOT discontinue","anchor_numbers":["−8,400","33.33%-vs-45%"],"mechanisms_required":["basket margin","attribution/defection share"],"internal_examples":["survey overstates true defection; test-store measurement"],"external_examples":["competitor rival kit; food-cost inflation"]},
  "C4":  {"conclusion":"ADD the 4th flight on incremental/marginal logic","anchor_numbers":["505","184,325","43.86%"],"mechanisms_required":["marginal vs fully-allocated cost","cannibalization/incrementality"],"internal_examples":["crew/maintenance/ops strain"],"external_examples":["competitor frequency match; fuel; slots"]},
  "C5":  {"conclusion":"decline at $38 / keep in-house","anchor_numbers":["−120,800","34.79","34-35"],"mechanisms_required":["avoidable vs unavoidable fixed","TAT leakage"],"internal_examples":["molecular staff retention/capability"],"external_examples":["reference-lab repricing; payer reimbursement"]},
  "C6":  {"conclusion":"implement the rate cut / yes","anchor_numbers":["94,900","350,400-vs-94,900"],"mechanisms_required":["both paths agree (revenue AND contribution)","≥1 checked-and-cleared reversal: parity $110 OR breakeven 72.63%-vs-74%"],"internal_examples":["forecast is the weak joint; re-underwrite 74%"],"external_examples":["competitor matching the cut"],"clean_special":true},
  "C7":  {"conclusion":"do NOT implement flat +20% as proposed (restructure, not reject)","anchor_numbers":["−168,869","−169K","+2M-vs-minus","16.48%"],"mechanisms_required":["annual-lock/mix","churn compounding"],"internal_examples":["churn estimates from one study; A/B first"],"external_examples":["competitor holds price → acquisition"]},
  "C8":  {"conclusion":"keep Rural","anchor_numbers":["−12,200","0.38%-vs-5%","10,000→1,000→−12,200"],"mechanisms_required":["avoidable vs allocated fixed","network/anchor-client risk"],"internal_examples":["needs variable-cost program"],"external_examples":["anchor client renegotiation"]},
  "C9":  {"conclusion":"reject the dormant-for-premium swap","anchor_numbers":["−68,250","38.75-vs-35.00","59.55-vs-55"],"mechanisms_required":["usage-cost margin (dormant > premium)","adverse retention on Casual"],"internal_examples":["premium real usage may exceed 8 visits; pilot"],"external_examples":["regulator views mass termination as unfair"]},
  "C10": {"conclusion":"selective / A-only migration (not everyone, not no one)","anchor_numbers":["−66,600-vs-+18,000","4.13"],"mechanisms_required":["segment winners/losers (only A pays more; B,C get unjustified cut)"],"internal_examples":["two pricing models → fairness pushback; packaging"],"external_examples":["B/C demand cheaper usage model → set rate ≥4.13¢"]},
  "C11": {"conclusion":"do NOT approve $12 across the board (targeted/peak pricing instead, not reject-all)","anchor_numbers":["−20,960","9.84-15-16.67","4.16"],"mechanisms_required":["naive ticket math is CORRECT within its perimeter but incomplete (concession leak)"],"internal_examples":["validate 15% elasticity via 2-theatre pilot"],"external_examples":["streaming release-window shift moves attendance"]},
  "C12": {"conclusion":"rent B1 and B3 only (not all five, not reject)","anchor_numbers":["13,000-vs-7,000","$10×participants"],"mechanisms_required":["capacity shadow-price","per-building selection"],"internal_examples":["relocate displaced programs before signing"],"external_examples":["operator demands all-five package → walk/counter"]},
  "C13": {"conclusion":"approve 24-mo cycle at HONEST size (not reject, not $4.9M)","anchor_numbers":["384,000-vs-4.86M","20,573"],"mechanisms_required":["naive frame counts only the selling side of the cycle"],"internal_examples":["doubled purchasing strains supply/logistics"],"external_examples":["used-car market is the single point of failure; hedge disposals"]},
  "C14": {"conclusion":"decline exclusivity / counter (not accept)","anchor_numbers":["−47,240","87.99%-vs-55%","88%","8.50-vs-7.16"],"mechanisms_required":["channel margin difference","partial migration/churn"],"internal_examples":["own-channel ops must stay <$4.90/order"],"external_examples":["Mealgate ranking retaliation → placement guarantees"]},
  "C15": {"conclusion":"kill the discount / implement","anchor_numbers":["1,543,200","2.7M-vs-1,543,200"],"mechanisms_required":["both paths agree (CFO direction AND cohort model)","≥1 checked-and-cleared reversal: scale/allocation $20→$21.13 OR j*=8,482-vs-12,000"],"internal_examples":["marketing's 12,000 projection is weak joint; pilot"],"external_examples":["competitor weaponizes removed discount in ads"],"clean_special":true},
  "C16": {"conclusion":"approve / run the teaser-card campaign (NOT reject)","direction":"approve","anchor_numbers":["+1,530,000 full-lifecycle","1.53 million net","45.78% survival breakeven","45.78%-vs-55%"],"transcription_variants":["one and a half million","forty six percent versus fifty five"],"mechanisms_required":["teaser window is an acquisition investment; lifetime revolving income of survivors flips it positive"],"internal_examples":["55% survival from one cohort; pilot before scaling"],"external_examples":["teaser-rate/affordability regulation; cost-of-funds/rate shock"]},
  "C17": {"conclusion":"keep the generic program (± fix economics); NOT discontinue","direction":"keep","anchor_numbers":["−26,000 net of cutting","twenty six thousand worse off","47.62% defection breakeven","47.62%-vs-60%"],"transcription_variants":["minus twenty six thousand","forty eight percent versus sixty"],"mechanisms_required":["script margin != visit margin (front-of-store cross-subsidy)","attribution: only defector share takes the basket"],"internal_examples":["survey overstates true defection; A/B a removal in test stores"],"external_examples":["reimbursement tightening; competitor rival generic program"]},
  "C18": {"conclusion":"discontinue the blade set BUT book the honest ~$32,000 (NOT $480,000, NOT keep)","direction":"discontinue at honest number","anchor_numbers":["$32,000 true benefit","thirty two thousand","×15 overstatement","480,000-vs-32,000"],"transcription_variants":["thirty two thousand a year","fifteen times overstated"],"mechanisms_required":["direction right (overhead avoidable) but magnitude overstated ×15 — forgone after-sales annuity (~$448k) ignored"],"internal_examples":["$11.20 pull-through estimate needs validation; pro-customer reliance"],"external_examples":["cut pushes pro customers to a competitor ecosystem"]},
  "C19": {"conclusion":"keep Highland — framed as CONFIRMING the CFO (NOT finding a reason to close)","direction":"keep","anchor_numbers":["+40,000 a month contribution","40,000/month","480,000 a year","$17.00 ARPU breakeven"],"transcription_variants":["forty thousand a month","four hundred eighty thousand a year","seventeen dollar arpu breakeven"],"mechanisms_required":["both paths agree KEEP: positive contribution AND no-spillover check","≥1 checked-and-cleared reversal: the C8-style network/anchor effect is ABSENT (standalone lease, zero anchor, $0 spillover)"],"internal_examples":["ARPU drift toward $17 breakeven; avoidable-fixed assumption"],"external_examples":["spectrum-lease repricing; rural-coverage regulation"],"clean_special":true,"anchor_note":"Bare '40,000' is BANNED — collides with 40,000 subscribers (raw size). Only qualified forms count ('40,000 a month', '480,000 a year'). If c1 FAILs by inventing a C8-style reversal (recommends close), c2 CANNOT pass on an anchor."},
  "C20": {"conclusion":"split mostly on shippers (~$10.80 / ~$1.20); NOT all-carriers, NOT all-shippers","direction":"split shippers-heavy","anchor_numbers":["31.49% optimal-vs-naive gap","31.49 percent","6.04M-vs-4.59M profit","10.80/1.20 split"],"transcription_variants":["thirty one percent better","six million versus four point six","ten eighty one twenty"],"mechanisms_required":["total take rises $12 either way so profit-per-load fixed; winning split minimizes loads lost","carriers far more sensitive (convex): all-on-carrier drops below baseline"],"internal_examples":["load-loss curve is an estimate; validate carrier churn on a fee test"],"external_examples":["rival marketplace poaches carriers; shipper-contract renewals shift sensitivity"]},
  "C21": {"conclusion":"keep the Fenwick Street branch (NOT close)","direction":"keep","anchor_numbers":["−1,140,000 net of closing","1.14 million cost of closing","12.50% flight breakeven","12.5%-vs-60% flight"],"transcription_variants":["minus one point one four million","one and a fourteen million","twelve and a half percent versus sixty"],"mechanisms_required":["fully-allocated P&L ignores deposit-funding value; departing deposits force costlier wholesale funding"],"internal_examples":["60% flight is an estimate; retention pilot; execution"],"external_examples":["rate-spread shift narrows deposit-vs-wholesale gap"]},
  "C22": {"conclusion":"keep the shade (NOT discontinue)","direction":"keep","anchor_numbers":["−695,000 true impact","695 thousand destroyed","−200,000 before halo","400,000-vs-695,000 contrast"],"transcription_variants":["six ninety five thousand","minus two hundred thousand before halo","four hundred versus six ninety five"],"mechanisms_required":["shade's own contribution already negative (gross lost > avoidable OH)","range halo/lineup: buyers of the shade drop other-shade purchases"],"internal_examples":["55% halo figure needs basket-data validation"],"external_examples":["competitor launches a similar shade"]},
  "C23": {"conclusion":"lease systems (NOT sell outright)","direction":"lease","anchor_numbers":["$18M lease margin","eighteen million lease","$18M-vs-$4M","$91.67 breakeven monthly"],"transcription_variants":["eighteen million versus four million","ninety one sixty seven a month","ninety two a month breakeven"],"mechanisms_required":["upfront sale margin hides the 20-year O&M annuity; full lease term dominates"],"internal_examples":["ties up capital; 20-yr O&M obligation; default risk; balance sheet"],"external_examples":["solar-subsidy change or rate shift alters payback"]},
  "C24": {"conclusion":"mine only the high-grade band (cutoff at marginal cost); NOT all bands","direction":"high band only","anchor_numbers":["$18M-vs-$3.4M","eighteen million versus three point four","1.222% cutoff grade"],"transcription_variants":["eighteen million against three point four million","one point two two two percent cutoff","cutoff around one point two percent"],"mechanisms_required":["averaging hides loss-making bands; mid and low recover less than processing cost; cutoff at marginal grade"],"internal_examples":["fixed-cost absorption / workforce planning with less mined"],"external_examples":["copper price rise lowers the cutoff; reprice with forward curve"]},
  "C25": {"conclusion":"kill the promo — framed as CONFIRMING the CFO (NOT keep)","direction":"kill","anchor_numbers":["−200,000 net (both paths kill)","two hundred thousand loss","30% incrementality breakeven","30%-vs-10% incrementality"],"transcription_variants":["minus two hundred thousand","thirty percent versus ten percent incremental","would only pay if thirty percent were new"],"mechanisms_required":["both paths agree KILL: cannibalization dominates","≥1 checked-and-cleared reversal: the incrementality is only 10% vs a 30% breakeven — the 'it's all incremental' reversal is FALSE"],"internal_examples":["10% incrementality from one study; pilot the removal on a title cohort"],"external_examples":["competitor weaponizes the removed discount in marketing"],"clean_special":true},
  "C26": {"conclusion":"keep the brand and grow private label alongside (NOT replace)","direction":"keep brand","anchor_numbers":["−21,000 net weekly","twenty one thousand worse off","41.46% defection breakeven","41.46%-vs-50% defection"],"transcription_variants":["minus twenty one thousand a week","forty one percent versus fifty","breakeven around forty one and a half"],"mechanisms_required":["private-label margin blind to brand traffic effect; departing shoppers take whole basket"],"internal_examples":["50% defection is an estimate; dual-shelf test"],"external_examples":["competitor stocks the dropped brand and pulls shoppers permanently"]},
  "C27": {"conclusion":"roll out dynamic pricing at the honest ~$1.24M (NOT $4M, NOT don't-roll-out)","direction":"roll out (honest number)","anchor_numbers":["$1.24M true benefit","one point two four million","×3.23 overstatement","$4M-vs-$1.24M"],"transcription_variants":["about one and a quarter million","three times overstated","four million versus one point two four"],"mechanisms_required":["peak uplift extrapolated to whole calendar; off-peak dates barely respond"],"internal_examples":["peak/off-peak split is an estimate; off-peak response could soften"],"external_examples":["resale platforms / competitors undercut peak pricing"]},
  "C28": {"conclusion":"keep the niche catalog (NOT cut)","direction":"keep","anchor_numbers":["−420,000 true effect","four hundred twenty thousand cost","$580,000 niche contribution","−260,000 before learning-curve"],"transcription_variants":["minus four twenty thousand","five hundred eighty thousand contribution","minus two sixty before the curve"],"mechanisms_required":["niche is profitable (premise false)","catalog learning-curve: cutting raises production cost of the rest"],"internal_examples":["learning-curve estimate needs production-data validation"],"external_examples":["competitor platform out-scales on catalog breadth"]},
  "C29": {"conclusion":"stock at medium density (NOT maximum, NOT low)","direction":"medium","anchor_numbers":["$628,200 medium profit","six twenty eight thousand","$144,200 gap over high","medium-vs-high $628k-vs-$484k"],"transcription_variants":["six hundred twenty eight thousand","about a hundred forty four thousand more","medium beats high"],"mechanisms_required":["max density != max profit: crowding lowers both survival and per-fish weight"],"internal_examples":["survival/weight factors are estimates; trial-pond validation"],"external_examples":["disease outbreak or feed-price spike shifts the optimum lower"]},
  "C30": {"conclusion":"repower at the honest ~$11.4M (NOT $29M, NOT don't-repower)","direction":"repower (honest number)","anchor_numbers":["$11.4M true uplift","eleven point four million","×2.54 overstatement","$29M-vs-$11.4M"],"transcription_variants":["about eleven point four million","two and a half times overstated","twenty nine million versus eleven four"],"mechanisms_required":["nameplate uplift assumes full hours; capacity factor is what matters"],"internal_examples":["34% new capacity factor is a manufacturer estimate; install downtime"],"external_examples":["power price / subsidy change moves payback"]},
  "C31": {"conclusion": "exit the line at the honest ~$1.76M (NOT $6.6M, NOT keep)", "direction": "exit at honest number", "anchor_numbers": ["$1.76M true benefit", "1,760,000", "×3.18 overstatement", "$6.6M-vs-$1.76M", "$4.56M breakeven reserve-release"], "transcription_variants": ["one point seven six million", "one seven six oh oh oh oh", "three point one eight times", "four point five six million"], "mechanisms_required": ["direction right but overstated ×3.18 — float income on reserves + reserve-release tail forfeited on exit"], "internal_examples": ["reserve-release is an actuarial judgment; validate before booking"], "external_examples": ["regulator requires run-off reserves delaying capital release"], "anchor_note": "Bare '$6.6M' (the naive headline) is NOT a valid anchor — it is the error being corrected."},
  "C32": {"conclusion": "keep the route (NOT cut)", "direction": "keep", "anchor_numbers": ["+6,300,000 true profit", "$6.3 million a year", "$60 breakeven onboard margin", "ticket-vs-onboard contrast"], "transcription_variants": ["six point three million", "sixty dollars breakeven", "ninety five dollars onboard"], "mechanisms_required": ["ticket P&L alone is negative; onboard spend (casino/bar/excursions) of the same passengers more than offsets"], "internal_examples": ["$95 onboard average could soften if fares are discounted to fill seats — validate mix"], "external_examples": ["itinerary or port-fee change shifts economics"]},
  "C33": {"conclusion": "run base tier only (NOT full capacity)", "direction": "base tier only / cutoff at marginal", "anchor_numbers": ["$32M-vs-$13.8M", "32,000,000", "max-tier $4,400-vs-$8,200", "$18.2M gap"], "transcription_variants": ["thirty two million versus thirteen point eight", "forty four hundred against eighty two hundred"], "mechanisms_required": ["yield-adjusted effective revenue vs marginal cost per tier; base subsidizes two loss-makers"], "internal_examples": ["fixed-cost absorption and utilization targets must be reset for idle tools"], "external_examples": ["wafer price rise or yield improvement could re-qualify the stretch tier"]},
  "C34": {"conclusion": "expand at the honest ~$3.2M (NOT $7M, NOT don't expand)", "direction": "expand at honest number", "anchor_numbers": ["$3.22M true benefit", "3,220,000", "×2.17 overstatement", "$7M-vs-$3.22M"], "transcription_variants": ["three point two two million", "two point one seven times", "three point two million"], "mechanisms_required": ["55% full-price sell-through; 45% clears at $18 below $25 cost, losing $630,000"], "internal_examples": ["55% sell-through is an estimate — test before a full buy"], "external_examples": ["fashion-cycle miss or competitor markdown war deepens the clearance tail"], "anchor_note": "Bare '$7M' is NOT a valid anchor — it is the naive claim being corrected."},
  "C35": {"conclusion": "consolidate the routes — framed as CONFIRMING the ops director, NOT finding a reason not to", "direction": "consolidate", "anchor_numbers": ["$340,000 saving", "340,000 a year", "zero revenue at risk", "$340,000 breakeven revenue-at-risk"], "transcription_variants": ["three hundred forty thousand", "three forty k"], "mechanisms_required": ["both paths agree consolidate: cost saving real AND no revenue offset", "≥1 checked-and-cleared reversal: the C8-style anchor-contract loss is ABSENT (contract is tonnage-based, route-agnostic, 0 anchor clients, SLA held)"], "internal_examples": ["confirm merged pickup schedule holds in practice before finalizing"], "external_examples": ["future contract renewal could add route-specific terms"], "clean_special": true, "anchor_note": "If c1 FAILS by inventing a contract-loss reversal that blocks consolidation, c2 CANNOT pass on an anchor."},
  "C36": {"conclusion": "build the hall at the honest ~$11.9M (NOT $21.6M, NOT don't build)", "direction": "build at honest number", "anchor_numbers": ["$11.9M true revenue", "11,880,000", "×1.82 overstatement", "$21.6M-vs-$11.9M"], "transcription_variants": ["eleven point nine million", "one point eight two times", "eleven point eight eight million"], "mechanisms_required": ["nameplate assumes all racks at full load simultaneously; cooling/power caps usable capacity at 55%"], "internal_examples": ["55% cooling cap is an engineering estimate — validate before capex"], "external_examples": ["power prices or a high-density tenant shift the economics"], "anchor_note": "Bare '$21.6M' is NOT a valid anchor — it is the naive claim."},
  "C37": {"conclusion": "plant variety B, the resistant one (NOT variety A)", "direction": "variety B", "anchor_numbers": ["disease-adjusted 170-vs-173.25", "173.25 bushels", "+$975,000 revenue difference", "$52M-vs-$51M"], "transcription_variants": ["one seventy versus one seventy three", "nine hundred seventy five thousand", "one seventy three point two five"], "mechanisms_required": ["nominal yield ≠ harvested yield; weight A by 30% disease chance × 50% loss → 170 vs B's 173.25"], "internal_examples": ["disease probabilities are historical estimates — validate for this region/season"], "external_examples": ["weather or a new pathogen strain shifts both varieties' risk"], "anchor_note": "Bare '200' and '175' (nominal yields) are RAW sizes, NOT anchors — the anchor is the disease-adjusted pair."},
  "C38": {"conclusion": "hold mid + scarce, clear common only (NOT clear all)", "direction": "hold appreciating subset", "anchor_numbers": ["$5.48M-vs-$3.64M", "5,480,000", "$1.84M uplift", "1,840,000"], "transcription_variants": ["five point four eight million", "one point eight four million", "three point six four million"], "mechanisms_required": ["per-model clear-now vs hold-later: common clears ($600>$500), mid and scarce appreciate ($2,600>$1,800; $11,000>$5,000)"], "internal_examples": ["holding ties up cash and carries storage/insurance cost"], "external_examples": ["vintage-model demand could cool, softening resale estimates"]},
  "C39": {"conclusion": "keep routine care (NOT cut)", "direction": "keep", "anchor_numbers": ["−540,000 true effect", "minus five hundred forty thousand", "$700,000 referral value", "$160,000 breakeven"], "transcription_variants": ["minus five forty thousand", "seven hundred thousand referral", "one sixty thousand breakeven"], "mechanisms_required": ["routine care drives the REFERRAL network (2,000 new clients/yr × $350 lifetime) — network inflow, not just direct contribution"], "internal_examples": ["referral figure should be validated by tracking how new clients actually find the practice"], "external_examples": ["a competitor clinic captures the routine visits and the referral flow with them"], "anchor_note": "Bare '$240,000' (routine contribution) is a RAW size, not the decision anchor."},
  "C40": {"conclusion": "keep the budget supplier (NOT drop)", "direction": "keep", "anchor_numbers": ["−1,920,000 true impact", "minus one point nine two million", "$600,000 own margin", "$1.32M cross-sell"], "transcription_variants": ["minus one point nine two million", "six hundred thousand own margin", "one point three two million"], "mechanisms_required": ["two layers: budget bookings are ALREADY profitable ($3/booking = $600k) before cross-sell; plus $1.32M attached car/activity margin"], "internal_examples": ["assumption that dropped customers leave entirely should be tested — some may rebook premium"], "external_examples": ["a competitor OTA captures those budget travelers and their cross-sell"], "anchor_note": "Bare '$1.6M' (take revenue) and '200,000 bookings' are RAW sizes, not anchors."},
  "C41": {"conclusion": "do the LBO at the honest ~$19.7M equity gain (NOT $60M, NOT don't)", "direction": "do the deal at honest number", "anchor_numbers": ["$19.68M true equity gain", "19,680,000", "×3.05 overstatement", "$60M-vs-$19.7M", "$40.3M uncovered debt service"], "transcription_variants": ["nineteen point seven million", "three point oh five times", "forty point three million"], "mechanisms_required": ["multiple expansion ignores the cost of the leverage: $57.6M debt service, 70% of which falls on equity return"], "internal_examples": ["debt-service coverage assumption should be stress-tested against a downside cash case"], "external_examples": ["rate rise or covenant breach could wipe out the return"], "anchor_note": "Bare '$60M' is NOT a valid anchor — it is the naive headline."},
  "C42": {"conclusion": "do NOT launch the value menu", "direction": "don't launch", "anchor_numbers": ["−50,000 net", "minus fifty thousand", "15%-vs-25% trade-down", "$125,000 cannibalization"], "transcription_variants": ["minus fifty thousand", "fifteen percent versus twenty five", "one twenty five thousand"], "mechanisms_required": ["mix-shift cannibalization: 25% of existing premium buyers trade down, losing $2.50 each — inside the base, not lost traffic"], "internal_examples": ["25% trade-down is an estimate — test in a few stores before chain-wide launch"], "external_examples": ["a competitor's value menu could force the decision regardless"], "anchor_note": "Bare '$75,000' (new-customer benefit) is the naive figure, not a valid standalone anchor."},
  "C43": {"conclusion": "adopt razor/blade — device near cost, earn on consumables (NOT high device price)", "direction": "razor/blade", "anchor_numbers": ["$105M-vs-$30M", "105,000,000", "$21,000 per device vs $6,000", "$1,000 breakeven consumable margin"], "transcription_variants": ["one hundred five million versus thirty", "twenty one thousand per device", "one thousand breakeven"], "mechanisms_required": ["device margin is one-time ($6,000); consumables recur ($4,000/yr × 5yr = $20,000), so near-cost pricing unlocks the larger stream"], "internal_examples": ["shifts revenue upfront→recurring; cash flow and sales incentives must be redesigned"], "external_examples": ["third-party consumables maker or a regulator erodes the recurring margin"]},
  "C44": {"conclusion": "do NOT cap surge pricing", "direction": "don't cap", "anchor_numbers": ["−78,000 net", "minus seventy eight thousand", "5%-vs-18% unfulfilled", "$108,000 lost rides"], "transcription_variants": ["minus seventy eight thousand", "five percent versus eighteen", "one hundred eight thousand"], "mechanisms_required": ["surge is the SIGNAL that pulls drivers online in peaks (feedback loop) — capping it leaves 18% of peak demand unfulfilled"], "internal_examples": ["18% unfulfilled estimate should be tested with a limited surge-cap trial"], "external_examples": ["a regulator could mandate surge caps regardless — design rider-friendly alternatives now"], "anchor_note": "Bare '$30,000' (satisfaction benefit) is the naive figure, not a valid standalone anchor."},
  "C45": {"conclusion": "renovate — framed as CONFIRMING the asset manager, NOT finding a reason not to", "direction": "renovate", "anchor_numbers": ["$8M net benefit", "8,000,000 over ten years", "100% realized vs 33.33% breakeven", "$1.2M annual uplift"], "transcription_variants": ["eight million net", "thirty three point three three percent", "one point two million a year"], "mechanisms_required": ["both paths agree renovate: uplift over hold beats capex AND the premium is realized", "≥1 checked-and-cleared reversal: the 'premium won't hold' fear is ABSENT (comparables realize 100% at 92% occupancy)"], "internal_examples": ["confirm our tenant mix can absorb the higher rent at renewal"], "external_examples": ["office-market softening could compress the premium — time to the leasing cycle"], "clean_special": true, "anchor_note": "If c1 FAILS by inventing a premium-collapse reversal that blocks renovation, c2 CANNOT pass on an anchor."},
  "C46": {"conclusion": "do NOT pour money into whale acquisition", "direction": "don't invest", "anchor_numbers": ["−$1,500 per whale", "minus fifteen hundred a whale", "realized LTV $2,000-vs-$3,500 CAC", "11.43% breakeven churn"], "transcription_variants": ["minus fifteen hundred", "two thousand versus thirty five hundred", "eleven point four three percent"], "mechanisms_required": ["20%/month churn → expected lifetime 5 months (1÷churn), so realized LTV $2,000 falls below the $3,500 CAC"], "internal_examples": ["20% churn is an average — segment whales by retention before abandoning the channel"], "external_examples": ["a competitor game poaches whales and steepens churn further"], "anchor_note": "Bare '$9,600' (naive LTV) is NOT a valid anchor — it is the error being corrected."},
  "C47": {"conclusion": "keep the low-margin product (NOT drop)", "direction": "keep", "anchor_numbers": ["−500,000 true effect", "minus five hundred thousand", "$800,000 by-product cost", "$3 breakeven external premium"], "transcription_variants": ["minus five hundred thousand", "eight hundred thousand", "three dollars breakeven"], "mechanisms_required": ["joint production: its output yields a by-product (1:1) a high-margin line needs; sourcing externally costs $8/unit more than making it"], "internal_examples": ["confirm the by-product can't be sourced more cheaply elsewhere"], "external_examples": ["a by-product supplier could reprice, shifting the calculus"], "anchor_note": "Bare '$300,000' (standalone loss) is the naive claim, not a valid standalone anchor."},
  "C48": {"conclusion": "age the vintage at the honest ~$1.3M (NOT $2.5M, NOT don't age)", "direction": "age at honest number", "anchor_numbers": ["$1.3M true gain", "1,300,000", "×1.92 overstatement", "$2.5M-vs-$1.3M", "$1.2M carry cost"], "transcription_variants": ["one point three million", "one point nine two times", "one point two million carry"], "mechanisms_required": ["premium ignores the carry: 3 years × $4/bottle storage, insurance and capital tied up = $1.2M"], "internal_examples": ["carry should include opportunity cost of capital, which may push it higher"], "external_examples": ["vintage-quality or demand shift over three years could erode the premium"], "anchor_note": "Bare '$2.5M' is NOT a valid anchor — it is the naive claim."},
  "C49": {"conclusion": "segment pricing peak/off-peak (NOT uniform)", "direction": "segment", "anchor_numbers": ["$17.46M-vs-$16M", "17,460,000", "$1.46M uplift", "1,460,000"], "transcription_variants": ["seventeen point four six million", "one point four six million", "sixteen million uniform"], "mechanisms_required": ["peak is inelastic (−5% at $100), off-peak elastic (+40% at $60 fills capacity) — one price leaves money at peak and prices out off-peak"], "internal_examples": ["elasticity estimates should be validated with a limited pricing test"], "external_examples": ["visitors may perceive peak pricing as unfair — needs careful communication"], "anchor_note": "Bare '200,000 visitors' and '$80' are RAW sizes, not anchors."},
  "C50": {"conclusion": "keep the backhaul routes (NOT drop)", "direction": "keep", "anchor_numbers": ["−3,200,000 true effect", "minus three point two million", "$11.2M connecting margin", "57.14% breakeven dependency"], "transcription_variants": ["minus three point two million", "eleven point two million", "fifty seven point one four percent"], "mechanisms_required": ["network density: the backhaul is a hub link; cutting it strands 80% of $14M connecting-route margin that can't reroute — not a per-leg load question"], "internal_examples": ["80% dependency should be validated by mapping which cargo actually reroutes versus is lost"], "external_examples": ["a partner carrier or alliance change alters the network math"], "anchor_note": "Bare '$8M' (standalone saving) is the naive claim, not a valid standalone anchor."},
  "C51": {"conclusion": "wait 12 months rather than build now", "direction": "wait", "anchor_numbers": ["$63.6M value of waiting", "63,636,363.64", "$33.6M option value", "$63.6M-vs-$30M"], "transcription_variants": ["sixty three point six million", "thirty three point six million", "sixty three point six versus thirty"], "mechanisms_required": ["price resolves in 12 months; waiting lets us build only in the high scenario, avoiding value destruction in the low one"], "internal_examples": ["12-month delay carries organizational cost — permits, team retention, capex escalation"], "external_examples": ["a competitor commits first and takes the offtake window"], "anchor_note": "Bare '$30M' (build-now NPV) is NOT a valid anchor on its own — it is the naive case. '$200M capex' and '$340M/$120M' scenario values are RAW inputs."},
  "C52": {"conclusion": "do NOT acquire the farm", "direction": "don't acquire", "anchor_numbers": ["−800,000 net", "minus eight hundred thousand", "$3.8M flexibility value", "$0.15 breakeven saving per kg"], "transcription_variants": ["minus eight hundred thousand", "three point eight million", "fifteen cents a kilo", "zero point one five"], "mechanisms_required": ["integration locks us into internal supply; in 40% of years external purchase would be $0.19/kg cheaper"], "internal_examples": ["40% cycle frequency is historical — validate over a longer series"], "external_examples": ["consolidation among the 26 independent farms would weaken our alternative supply"], "anchor_note": "Bare '$3M captured margin' is the naive claim, not a valid standalone anchor. '50,000,000 kg' and '$34M price' are RAW."},
  "C53": {"conclusion": "reprice the transfer to at least $153 so Division B serves internally", "direction": "reprice / serve internally", "anchor_numbers": ["$153 alignment price", "$1.32M-vs-$1.16M", "$160,000 group gain", "1,320,000"], "transcription_variants": ["one fifty three", "one point three two million versus one point one six", "one hundred sixty thousand"], "mechanisms_required": ["full-cost transfer price includes $38 non-incremental allocated fixed; group economics run on B's marginal $95 versus the $161 A pays outside"], "internal_examples": ["utilisation figure is from the prior quarter and unrestated — confirm B has spare capacity"], "external_examples": ["if B's outside demand strengthens, the alignment price rises and policy needs revisiting"], "bonus_signal": "flags the stale/unrestated utilisation line", "anchor_note": "Bare '$140 transfer price', '$95 variable cost', '$58 outside contribution' are RAW inputs. '$45 internal contribution' alone is an intermediate, not the decision anchor."},
  "C54": {"conclusion": "pool buffer capacity across the four sites", "direction": "pool", "anchor_numbers": ["79.2-vs-39.6 beds", "$3.37M saving", "3,366,000", "39.6 beds saved"], "transcription_variants": ["seventy nine point two versus thirty nine point six", "three point three seven million", "three point three six six million"], "mechanisms_required": ["independent variability adds as the square root; combined SD is 24 not 48, so one shared buffer holds the same service level"], "internal_examples": ["pooling depends on transfer logistics working under winter pressure — pilot before removing capacity"], "external_examples": ["a flu surge hits all four sites at once, breaking the independence assumption"], "anchor_note": "Bare '12 standard deviation', '1.65 z-value', '$85,000 per bed' are RAW inputs. '19.8 beds' (single-site buffer) is an intermediate."},
  "C55": {"conclusion": "launch the bundle at the honest ~$262.5k/month (NOT $900k, NOT don't launch)", "direction": "launch at honest number", "anchor_numbers": ["$262,500 true uplift", "262,500 a month", "×3.43 overstatement", "$900k-vs-$262.5k"], "transcription_variants": ["two hundred sixty two thousand five hundred", "three point four three times", "two sixty two five hundred"], "mechanisms_required": ["mix: 35% upgrade from broadband (+$30), 40% already hold two (+$5), 25% already hold all three (−$15 discount)"], "internal_examples": ["the mix comes from survey — validate against billing data before launch"], "external_examples": ["a competitor bundle could force a deeper discount"], "anchor_note": "Bare '$900,000' is NOT a valid anchor — it is the naive claim being corrected. '$85 sum of parts' and '$70 bundle price' are RAW inputs."},
  "C56": {"conclusion": "promote Value only, not both brands", "direction": "value-only", "anchor_numbers": ["$6.48M-vs-$5.3M", "6,480,000", "22.28% gap", "$0.26 breakeven discount", "$1.18M gap"], "transcription_variants": ["six point four eight million versus five point three", "twenty two point two eight percent", "twenty six cents"], "mechanisms_required": ["70% of Premium's lift is taken from own Value, and the $0.75 discount applies to every Premium unit; Value's lift is 90% genuinely new at $0.12"], "internal_examples": ["the 70% cannibalization figure should be validated with a regional test before cancelling a brand's plan"], "external_examples": ["a competitor promoting hard against Premium could cost share if we hold full price"], "anchor_note": "Bare '$6.3M no-promo profit' is a RAW baseline. '2,000,000 units', '$1.80 margin', '+25%/+30% lifts' are RAW inputs."},
  "C57": {"conclusion": "close the whey line — framed as CONFIRMING the manager, NOT finding a reason not to", "direction": "close", "anchor_numbers": ["$1.4M total benefit", "1,400,000", "$4.50-vs-$6.00 external-internal", "$8.00 breakeven external price"], "transcription_variants": ["one point four million", "four fifty versus six dollars", "eight dollars breakeven"], "mechanisms_required": ["both paths agree close: standalone saving real AND the by-product dependency does not reverse it", "≥1 checked-and-cleared reversal: the C47-style by-product need is ABSENT (external $4.50 < internal $6.00, deep market, certified equivalent)"], "internal_examples": ["lock a supply contract before decommissioning rather than relying on spot"], "external_examples": ["whey is commodity-linked — prices could rise, so a multi-year contract or collar is worth having"], "clean_special": true, "anchor_note": "If c1 FAILS by inventing a by-product dependency that blocks closure, c2 CANNOT pass on an anchor. Bare '$800,000' (standalone saving) is the naive figure — valid only alongside the $1.4M full benefit or the external-internal comparison."},
  "C58": {"conclusion": "differentiate contract terms by customer volatility (long=stable, short=volatile)", "direction": "differentiate / split", "anchor_numbers": ["$10.01M-vs-$8.68M", "10,010,000", "15.32% gap", "$82-vs-$120 volatile per tonne", "38.33% breakeven"], "transcription_variants": ["ten point oh one million versus eight point six eight", "fifteen point three two percent", "eighty two dollars a tonne", "thirty eight point three three percent"], "mechanisms_required": ["long-term premium is pure gain for stable customers but volatile customers under-deliver 70% of the time at $120/t, turning $166 into an expected $82"], "internal_examples": ["classifying customers as stable or volatile needs a consistent rule or sales will game it"], "external_examples": ["an end-market downturn could push currently stable customers into the volatile group"], "anchor_note": "Bare '$120 base margin' and '$46 premium' are RAW inputs. '$166/t stable-long' alone is an intermediate."},
  "C59": {"conclusion": "complete the programme, do NOT terminate", "direction": "complete", "anchor_numbers": ["forward NPV +$26M", "26,000,000", "$41M swing", "$15M termination cost", "33.33% breakeven probability"], "transcription_variants": ["twenty six million", "forty one million", "fifteen million termination", "thirty three point three three percent"], "mechanisms_required": ["the $180M is sunk; decision is $40M more against a 55% chance of $120M", "second layer: terminating itself costs $15M, so killing destroys value twice"], "internal_examples": ["the 55% probability is the load-bearing parameter — re-test against latest trial data; also reconcile the $188M-vs-$180M spend inconsistency"], "external_examples": ["a competitor filing first or a regulatory shift could cut commercial value"], "bonus_signal": "flags the $188M-vs-$180M spend inconsistency", "anchor_note": "Bare '$180M spent' is the sunk anchor being REJECTED — never a valid anchor. '$120M value if approved' alone is a RAW input; '$66M expected value' is an intermediate."},
  "C60": {"conclusion": "bid cost-plus rather than fixed-price", "direction": "cost-plus", "anchor_numbers": ["$6.12M-vs-$5.7M expected margins", "6,120,000", "42% breakeven overrun probability", "$74.3M expected cost"], "transcription_variants": ["six point one two million versus five point seven", "forty two percent", "seventy four point three million"], "mechanisms_required": ["45% of comparable projects overrun by $14M; under fixed-price we absorb it, lifting expected cost to $74.3M and cutting expected margin below the cost-plus fee"], "internal_examples": ["the 45% comes from 20 comparable projects — test against this well's geology and rig spec"], "external_examples": ["the client could refuse cost-plus or price it down"], "bonus_signal": "volunteers that the margin is thin (42% breakeven vs 45% actual, 3pp cushion)", "anchor_note": "Bare '$12M' (fixed-price margin on base estimate) is NOT a valid anchor — it is the naive claim. '$80M contract value' and '$68M base cost' are RAW inputs."},
};

/* ───────────────────────── library ───────────────────────────────────────── */
let _byId = null;
function caseById(id) {
  if (!_byId) { _byId = new Map(); for (const c of (CASES_DATA.cases || [])) _byId.set(c.id, c); }
  return _byId.get(id);
}

// Flatten multipart steps the way the client used to, but assign each flat step
// a stable grading id (gid = its index) so client and server never disagree.
function flatten(c) {
  const flat = [];
  (c.steps || []).forEach(st => {
    if (st.type === 'multipart') {
      (st.parts || []).forEach((p, i) => {
        const q = Object.assign({}, p);
        if (i === 0) { q._wrap = st.prompt; q._reveal = st.reveal_exhibits_on_enter; }
        flat.push(q);
      });
    } else {
      const q = Object.assign({}, st);
      if (st.reveal_exhibits_on_enter) q._reveal = st.reveal_exhibits_on_enter;
      flat.push(q);
    }
  });
  flat.forEach((q, i) => { q.gid = i; });
  return flat;
}

const KEY_FIELDS = ['answer', 'answer_explain', 'validation', 'model_answer', 'trigger_phrases', 'expected', 'fallback', 'rubric_ref', 'checklist'];
// Client-safe copy of a flat step: keep prompt / type / option TEXT / reveal ids
// / gid; strip every answer key (incl. the voice checklist, which spoils the
// correct recommendation).
function sanitizeStep(q) {
  const out = {};
  for (const k of Object.keys(q)) {
    if (KEY_FIELDS.indexOf(k) >= 0) continue;
    if (k === 'options') {
      out.options = (q.options || []).map(o => ({ text: o.text }));   // drop .correct
    } else {
      out[k] = q[k];
    }
  }
  return out;
}

// Exhibits carry both display data (blocks/title) AND spoiler metadata
// (trigger_phrases to reveal them, no_spoiler_note, fallback). Ship only what
// the renderer needs.
function sanitizeExhibit(ex) {
  return { id: ex.id, title: ex.title, reveal: ex.reveal, blocks: ex.blocks || [] };
}

function sanitizeCase(c) {
  return {
    id: c.id, title: c.title, meta_tag: c.meta_tag, scenario: c.scenario,
    exhibits: (c.exhibits || []).map(sanitizeExhibit),
    steps: flatten(c).map(sanitizeStep)
  };
}

/* ───────────────────────── grading ───────────────────────────────────────── */
function num(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[, ]/g, ''));
  return isNaN(n) ? NaN : n;
}
function fmtVal(v) { const n = num(v); return isFinite(n) ? n.toLocaleString('en-US') : String(v); }

function gradeChoice(q, selected) {
  const req = [];
  (q.options || []).forEach((o, i) => { if (o.correct) req.push(i); });
  const sel = Array.isArray(selected) ? selected.map(Number) : [];
  const ok = req.length === sel.length && req.every(i => sel.indexOf(i) >= 0);
  // correctIdx lets the (key-free) client mark right/wrong options after submit.
  return { ok, correctIdx: req, validation: q.validation || '' };
}
function gradeNumber(q, value) {
  const ans = num(q.answer), val = num(value);
  const tol = Math.max(0.01, Math.abs(ans) * 0.005);
  const ok = isFinite(val) && Math.abs(val - ans) <= tol;
  return { ok, answer: fmtVal(ans), answer_explain: q.answer_explain || '' };
}

/* ───────────────────────── infra (shared pattern) ────────────────────────── */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 529]);
async function fetchAnthropicWithRetry(url, options, timeoutMs, maxRetries) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(Math.min(700 * Math.pow(2, attempt - 1), 4000));
    try {
      const resp = await fetchWithTimeout(url, options, timeoutMs);
      if (RETRIABLE_STATUS.has(resp.status) && attempt < maxRetries) continue;
      return resp;
    } catch (e) { lastErr = e; if (attempt >= maxRetries) throw e; }
  }
  if (lastErr) throw lastErr;
}
async function rateLimited(userId, sbUrl, sbKey, token) {
  try {
    const resp = await fetchWithTimeout(sbUrl + '/rest/v1/rpc/check_and_increment_rate_limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: sbKey, Authorization: 'Bearer ' + token },
      body: JSON.stringify({ p_user_id: userId, p_window_seconds: RATE_WINDOW_MS / 1000, p_limit: RATE_LIMIT })
    }, AUTH_TIMEOUT_MS);
    if (!resp.ok) { console.error('Casey rate-limit RPC returned', resp.status); return false; }
    return (await resp.json()) === false;
  } catch (e) { console.error('Casey rate-limit RPC failed:', e); return false; }
}

// One bounded model call + a single thinking-truncation retry inside a hard
// deadline (same discipline as claude.js), returning parsed JSON or null.
async function graderJSON(system, userText, maxTokens) {
  const T0 = Date.now();
  const BUDGET_MS = 52 * 1000;
  const call = (mt, timeoutMs) => fetchAnthropicWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify({ model: GRADER_MODEL, max_tokens: mt, system: [{ type: 'text', text: system }], messages: [{ role: 'user', content: userText }] })
  }, timeoutMs, 0);
  const textOf = d => (d && Array.isArray(d.content)) ? d.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
  const parse = t => { try { const m = String(t || '').match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch (e) { return null; } };
  let resp = await call(maxTokens, 45 * 1000);
  let data = await resp.json();
  let parsed = parse(textOf(data));
  // Retry once inside the deadline if the model was truncated OR returned nothing
  // parseable — the latter is the usual cause of a "could not grade".
  const needsRetry = !parsed || (data && data.stop_reason === 'max_tokens');
  const timeLeft = BUDGET_MS - (Date.now() - T0);
  if (needsRetry && timeLeft > 12 * 1000) {
    try { const r2 = await call(Math.min(maxTokens * 2, 4000), timeLeft - 2000); if (r2.status === 200) { const d2 = await r2.json(); const p2 = parse(textOf(d2)); if (p2) parsed = p2; } } catch (e) { /* keep */ }
  }
  return parsed;
}

async function gradeOpen(q, answer) {
  const sys = 'You are a strict but fair BCG case-interview examiner. Grade the candidate answer on a binary pass/fail. Return ONLY JSON: {"pass":true|false,"feedback":"1 short sentence IN ENGLISH: what earned or missed the pass"}.';
  const u = 'PASS CRITERION: ' + (q.validation || 'a reasonable, on-point answer') +
    '\nMODEL ANSWER: ' + (q.model_answer || '—') +
    '\nCANDIDATE ANSWER: ' + answer;
  const j = await graderJSON(sys, u, 400);
  return j || { pass: true, feedback: 'Answer accepted.' };
}

/* ───────────────────────── handler ───────────────────────────────────────── */
export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || FALLBACK_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  try {
    const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: { message: 'Authentication required.' } });
    const sbUrl = process.env.SUPABASE_URL, sbKey = process.env.SUPABASE_ANON_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: { message: 'Server auth not configured.' } });

    const raw = JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY_BYTES) return res.status(413).json({ error: { message: 'Request too large.' } });

    let userResp;
    try {
      userResp = await fetchWithTimeout(sbUrl + '/auth/v1/user', { headers: { apikey: sbKey, Authorization: 'Bearer ' + token } }, AUTH_TIMEOUT_MS);
    } catch (e) { return res.status(504).json({ error: { message: 'Authentication timed out. Please try again.' } }); }
    if (!userResp.ok) return res.status(401).json({ error: { message: 'Invalid or expired session.' } });
    const user = await userResp.json();
    const userId = user && user.id;
    if (!userId) return res.status(401).json({ error: { message: 'Invalid session.' } });

    const body = req.body || {};

    // list — no model call, meta only.
    if (body.action === 'list') {
      return res.status(200).json({ cases: (CASES_DATA.cases || []).map(c => ({ id: c.id, title: c.title, meta_tag: c.meta_tag })) });
    }
    // case — sanitized (no answer keys).
    if (body.action === 'case') {
      const c = caseById(body.caseId);
      if (!c) return res.status(400).json({ error: { message: 'Unknown case.' } });
      return res.status(200).json({ case: sanitizeCase(c) });
    }
    // grade — rate-limited, keys never leave.
    if (body.action === 'grade') {
      if (await rateLimited(userId, sbUrl, sbKey, token)) {
        return res.status(429).json({ error: { message: 'Too many requests. Please slow down.' } });
      }
      const c = caseById(body.caseId);
      if (!c) return res.status(400).json({ error: { message: 'Unknown case.' } });
      const flat = flatten(c);
      const gid = Number(body.gid);
      const q = flat[gid];
      if (!q) return res.status(400).json({ error: { message: 'Unknown step.' } });
      const p = body.payload || {};
      const t = q.type;

      if (t === 'select_all' || t === 'select_fewest' || t === 'single_choice') {
        return res.status(200).json(gradeChoice(q, p.selected));
      }
      if (t === 'enter_number') {
        return res.status(200).json(gradeNumber(q, p.value));
      }
      if (t === 'open_text_elicitation') {
        const answer = String(p.answer || '');
        const trg = (q.trigger_phrases || []).some(ph => answer.toLowerCase().indexOf(String(ph).toLowerCase()) >= 0);
        let pass = trg;
        if (!trg) { const r = await gradeOpen(q, answer); pass = !!r.pass; }
        return res.status(200).json({ pass, validation: q.validation || 'Right thing to probe.', revealExhibit: q.reveal_exhibit || null });
      }
      if (t === 'voice') {
        // Canonical structured rubric for every case (C1-C30). Falls back to the
        // book checklist only if a rubric is somehow absent (defensive).
        const rubric = CASEY_RUBRICS[q.rubric_ref] || null;
        const grounding = rubric
          ? ('rubric: ' + JSON.stringify(rubric))
          : ('voice_checklist:\n' + (q.checklist || '') + '\nmodel_answer:\n' + (q.model_answer || ''));
        const u = 'case_id: ' + (q.rubric_ref || c.id) + '\n' + grounding + '\ntranscript: ' + String(p.transcript || '');
        const j = await graderJSON(CASEY_VOICE_SYSTEM, u, 1200);
        // Genuine grader failure → distinguishable flag, NOT a fake 0/4 "weak".
        // The client shows a neutral retry (no penalty, no game consumed) and
        // does not reveal the partner model answer yet.
        if (!j || !j.criteria) return res.status(200).json({ graded: false });
        j.graded = true;
        j.model_answer = q.model_answer || '';
        return res.status(200).json(j);
      }
      // open_text / brainstorm
      return res.status(200).json(await gradeOpen(q, String(p.answer || '')));
    }

    return res.status(400).json({ error: { message: 'Unknown action.' } });
  } catch (err) {
    console.error('CasEdge Casey error:', err);
    return res.status(500).json({ error: { message: 'Something went wrong. Please try again.' } });
  }
}
