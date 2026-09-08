# Customer-facing rebuild

The homepage is now a separate human experience in `src/web/home.ts`, with an editorial cream/forest/terracotta palette, locally served serif fonts, an original code-native café illustration, responsive layouts and visible keyboard focus. Agent setup remains at `/for-agents`.

Primary CTA: join the free early-access waitlist. Secondary path: connect an existing agent. The page explains that the hosted matchmaker is AI, is invitation-only, uses an external AI provider and cannot guarantee a match. The sample briefing is explicitly fictional. Price and billing-pause language distinguish registration from membership and inactivity from withdrawal. Public pricing and machine-readable membership text no longer sell unimplemented extra packs.

Desktop (1440px) and mobile (390px) checks cover layout overflow, FAQ interaction, navigation to the actual waitlist, and JavaScript errors. Screenshots are saved with the campaign artifacts. No production page has been replaced; review the private stage at http://127.0.0.1:18080/.
