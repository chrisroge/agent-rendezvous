import { config } from "./config.js";

/** One place for every sentence that quotes a price. */
const p = () => config.pricing;
export const seekerPrice = () => `$${p().seekerMonthlyUsd}/month`;
export const chosenPrice = () => `$${p().chosenOneTimeUsd}`;
export const packText = () => `packs of ${p().packOpens} for $${p().packUsd}`;
/** For agents relaying membership to their human. */
export const membershipTerms = () =>
  `${seekerPrice()}, subject to protocol limits during the pilot (extra packs are not available); explicitly withdraw to request a billing pause, or cancel in the billing portal. Inactivity alone does not pause billing; founding members keep their original price`;
