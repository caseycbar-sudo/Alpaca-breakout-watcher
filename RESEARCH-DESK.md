# Research desk

The Research tab now combines saved watcher observations with 21 external source destinations across news/filings, macro/politics, day trading, short interest, options and ownership disclosures. Symbol search filters saved candidate headlines, shows the scan's available price/spread/relative-volume observations and builds company-filing/chart/options-chain links. Missing observations remain missing.

The Federal Register reader calls one fixed public endpoint from the authenticated Hub, on demand. It requests eight recent documents; no ticker, account, position or credential is transmitted. Reads coalesce and cache in the Worker isolate for ten minutes (one minute after failure). A six-second timeout and 180 KB streaming limit bound the request. Returned URLs must be HTTPS on www.federalregister.gov; document text is escaped by the frontend. Publication date and effective date remain separate. The public API is an informational rendition; users should confirm legal text in the linked official publication. Recent documents are broad agency coverage, not stock relevance ranking or intraday news.

The scenario calculator models a long stock/ETF position using a positive target, stop distance and an all-in round-trip cost percentage. Net target = position × (target − cost) / 100; modeled loss = position × (stop + cost) / 100. The two-outcome break-even rate is loss / (loss + gain). It is undefined when costs consume the target. The calculator does not estimate an edge, broker capacity, or actual stop execution. Draft values and results survive topic filtering and state refreshes within the view.

## Data coverage and remaining work

- Saved candidate news is already available from the watcher. It is not a full watchlist/holdings news feed. Publication and first-observed times are kept visible.
- The public-source library requires no Hub secrets. External providers may have delays, logins, access terms and paid tiers; opening one does not connect its data to the Hub.
- Fed/BLS/BEA/Census calendars are source links. There is no imported rolling five-trading-day event list yet.
- Options chains, Greeks, historical open interest, short interest, borrow rates and congressional/insider disclosures are not imported. Source links and questions are useful context but are not live values.
- No continuous news stream or latency SLA is claimed. A complete filtered news feed needs a separately configured server-side provider, measured latency/coverage, deduplication and cache/failure behavior. Never copy a broker or ChatGPT connector credential into frontend code.
- Politics is organized around original documents and effective dates, without a directional or sentiment score.

## Source and design integration

Grok's trading-hub commits 96ce565 and 6d9574d replaced the shared stylesheet with a 60-line fragment containing a truncation placeholder. This branch restores the complete prior stylesheet and retains his gradient cards and hero refinements, while merging them with the workspace design and Claude's lab figures. The source includes a regression check against the truncation placeholder and missing core layout selectors.

## Verification and review

The source registry's primary destinations were checked via web retrieval. The exact Federal Register API URL returned HTTP 200 and eight documents in a direct read during implementation. Node checks cover escaping, unsafe links, symbol filtering, missing/future timestamps and scenario arithmetic. Worker checks cover policy normalization, cache/coalescing, visible failure and anonymous endpoint rejection. The module receives its own asset stamp and loads before app.js under the existing CSP.

Synthetic preview: `node scripts/preview-workspace.mjs /absolute/output/directory`. It uses no real account data and refuses writes. The external policy endpoint is intentionally unavailable in the static preview. Browser checks cover desktop and a 390px phone frame, symbol search, Options filtering, calculator arithmetic and preserving inputs/results on filtering. No horizontal overflow was measured (375px content and viewport after the scrollbar).

Independent review should focus on source usefulness, accessibility on a phone, API error handling, time labels, calculation assumptions, preservation of Grok/Claude changes, and the distinction between external links and imported observations. This addition has not received independent review or a production release.
