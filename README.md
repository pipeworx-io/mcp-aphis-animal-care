# @pipeworx/aphis-animal-care

USDA Animal Welfare Act licensees and registrants — commercial dog breeders,
dealers, exhibitors, carriers and research facilities — together with the APHIS
Animal Care inspection reports written about them, their critical/direct
violation counts and links to the official signed report PDFs.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `aphis_licensee_search(state?, license_type?, name?, city?, zip?, certificate_number?, customer_number?, kind?, status?, limit?, page?)` —
  who holds an AWA licence or registration. Answers "USDA licensed dog breeders
  in Missouri", "look up certificate 43-A-6814", "is this kennel USDA
  licensed". Returns name, certificate number, licence class, certificate
  status (Active / Cancelled / Revoked), facility city/county/ZIP.
- `aphis_inspection_reports(state?, license_type?, name?, city?, zip?, certificate_number?, customer_number?, animal_category?, citation?, teachable_moments_only?, limit?, page?)` —
  Animal Care inspection reports with inspection date, licensee, location,
  counts of critical / direct / non-critical violations and teachable moments,
  and `report_pdf_url` (the official signed report).
- `aphis_inspection_filter_options(query?, kind?, limit?)` — the 34 animal
  categories and 2,165 AWA citation section codes the inspection filters
  accept.

## Auth

Keyless. No account, no cookies, no session token.

## Data sources

- <https://efile.aphis.usda.gov/PublicSearchTool/s/sfsites/aura> — the Aura
  endpoint behind the USDA APHIS eFile Public Search Tool. Actions used:
  `apex://EFL_PSTController/ACTION$doCustomerQuery` (licensees/registrants),
  `…$doIRSearch_UI` (inspection reports), `…$getSearchSetup` (state and
  licence-type vocabularies), `…$getIRSearchFilters` (animal categories,
  citation section codes).

### Things the next person would otherwise rediscover the hard way

There is no documented REST API for this data and no key. The Public Search
Tool is a Salesforce Lightning community; its search runs over the Aura
endpoint. The Apex class and methods were captured by driving one real search
in a headless Chrome under CDP and reading the request off the wire — blind
guessing at Apex class names does not work, because a wrong class and a wrong
method return the byte-identical `No apex action available for X.y`.

- **"Guest user access is not allowed" is not a policy block.** A malformed or
  missing `aura.context` returns that message with descriptor
  `aura:invalidSession`, which reads as a hard refusal of anonymous callers.
  It is not — the endpoint serves guests. Measured 2026-09-05, `aura.context`
  needs nothing beyond `{"mode":"PROD","app":"siteforce:communityApp"}`.
- **`fwuid` does not matter.** A bogus fwuid, and an omitted one, both return
  `SUCCESS`. This pack therefore does not scrape a framework version off the
  page and cannot break when Salesforce rolls it.
- **`index` is a page number, not a row offset**, and the upstream caps the
  underlying SOQL offset at 2,000 rows: `page * page_size <= 2000`. Past that
  it throws `Maximum SOQL offset allowed for apiName EFLLicense__c is 2000`.
  `totalCount` is still the true unpaged count (4,986 Class A breeder licences
  in Missouri alone), so narrow rather than page.
- **`irFilterCriteria` keys are SINGULAR.** `animalCategory` and `sectionCode`
  each take one Salesforce id. The plural `animalCategories: [id]` is silently
  ignored and returns the *unfiltered* count with a 200 — a silent wrong
  answer, not an error.
- **No date filter exists** on the inspection search. `inspectionDateFrom`,
  `fromDate` and `startDate` are all ignored. Filter caller-side on
  `inspection_date`.
- **A licence record is not a business.** One person appears once per
  certificate, and most rows in any state are Cancelled historical licences.
  `status: "active"` is the argument that matters for "who is licensed today".
- `sObjectType` selects the register: `EFLLicense__c` (Class A/B/C licensees)
  vs `EFLRegistration__c` (registrants — research facilities, carriers,
  intermediate handlers).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "aphis-animal-care": {
      "url": "https://gateway.pipeworx.io/aphis-animal-care/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/aphis-animal-care/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/aphis_licensee_search \
  -H 'Content-Type: application/json' \
  -d '{"state":"Missouri","license_type":"BREEDER","status":"active","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/aphis_licensee_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "aphis-animal-care": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-aphis-animal-care"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-aphis-animal-care
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Aphis Animal Care data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
