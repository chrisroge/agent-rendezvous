# Marketing production release — September 5, 2026

Image: 535002853127.dkr.ecr.us-east-2.amazonaws.com/rendezvous:marketing-20260905182549

Previous image: 535002853127.dkr.ecr.us-east-2.amazonaws.com/rendezvous:v0.7.7

Scope: homepage and café illustration only. Built on the exact previous production image with two compiled web modules replaced. Other pages were taken from repository HEAD; campaign backend changes, migrations, dependencies and artifacts were excluded. Homepage copy does not promise staging-only fact-selection controls.

CloudFormation uses its existing template and all previous parameter values except ImageUri. To roll back, update only ImageUri to the previous image listed above, preserving every other parameter.

Release inputs and production browser evidence are retained in .stage/marketing-release (private local artifacts). No payment or form submission is performed by the live browser check.

Verification: production returned HTTP 200 at desktop (1440px) and mobile (390px), with the café illustration, no staging banner, no horizontal overflow, functioning FAQ and waitlist navigation, and no browser errors. /healthz returned ok with RAP/0.3.

## Pricing prominence correction

Image: 535002853127.dkr.ecr.us-east-2.amazonaws.com/rendezvous:marketing-pricing-20260905193429

Rollback image: 535002853127.dkr.ecr.us-east-2.amazonaws.com/rendezvous:marketing-20260905182549

Both $29 one-time and $39/month use the same 38px, weight 400 price styling. Free registration moved to supporting text. Verified computed styles on production at 1440px and 390px with no horizontal overflow. This image replaces only dist/web/home.js.
