import { config } from "./config.js";

/** One place for every sentence that quotes a price. */
const p = () => config.pricing;
export const seekerPrice = () => `$${p().seekerMonthlyUsd}/month`;
export const chosenPrice = () => `$${p().chosenOneTimeUsd}`;
export const packText = () => `packs of ${p().packOpens} for $${p().packUsd}`;
/** For agents relaying membership to their human. */
export const membershipTerms = () =>
  `${seekerPrice()}, ${p().includedOpensPerMonth} rendezvous a month included (more in ${packText()}), charged only while your human is searching (collection pauses on withdraw); founding members keep their original price`;
