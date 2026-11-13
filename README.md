# 🚀 Nova AI

> **Know Before You Apply.**

Nova AI is an AI-powered opportunity eligibility and application copilot that helps students and early-career candidates understand whether they are a strong fit for internships, scholarships, fellowships, competitions, grants, and other opportunities.

Instead of simply asking **"Can I apply?"**, Nova AI helps answer:

* **Should I apply?**
* **How strong is my profile?**
* **What evidence supports my fit?**
* **What requirements am I missing?**
* **What should I improve before applying?**

---

## 🌐 Live Demo

**[https://nova-ai-delta-five.vercel.app/](https://nova-ai-delta-five.vercel.app/)**

---

## ✨ What Nova AI Does

Nova AI takes two inputs:

1. **Your profile** — resume, skills, experience, education, projects, and background.
2. **An opportunity** — internship, scholarship, fellowship, competition, grant, or other opportunity description.

It then uses AI to produce a structured eligibility and application-readiness report.

### 🧠 Eligibility Intelligence

* Eligibility verdict
* Match score
* AI confidence score
* Requirement-by-requirement analysis
* Candidate strengths
* Missing requirements
* Skills gap analysis
* Hidden requirement detection
* Risk analysis
* Application readiness assessment

### 📄 Resume & ATS Analysis

* Resume quality assessment
* ATS compatibility analysis
* Resume strengths
* Potential red flags
* Missing information
* Improvement recommendations
* Evidence-based profile analysis

### 🚀 Application Copilot

Nova AI doesn't stop at telling you what you're missing.

It can also provide:

* Personalized improvement roadmap
* Resume improvement suggestions
* Cover-letter guidance
* Interview preparation questions
* Recommended learning resources
* Skill-building recommendations
* Risk mitigation strategies

---

## 🎯 Why Nova AI?

Opportunity applications are often unnecessarily difficult.

A candidate may have to read several pages of eligibility requirements, compare them against their resume, identify missing qualifications, determine whether those gaps are deal-breakers, and then decide whether the application is worth their time.

Nova AI compresses that process into one structured analysis.

The goal isn't to blindly tell you **"yes"** or **"no."**

The goal is to show you **why**.

---

## 🏗️ Architecture

Nova AI uses a lightweight client-server architecture:

```text
User
 │
 ▼
Nova AI Web Interface
 │
 ├── Candidate Profile / Resume
 │
 └── Opportunity Description
 │
 ▼
Serverless Analysis API
 │
 ▼
Groq LLM
 │
 ▼
Structured Eligibility Analysis
 │
 ├── Eligibility
 ├── Match Score
 ├── Evidence
 ├── Skill Gaps
 ├── ATS Analysis
 ├── Risks
 ├── Recommendations
 └── Learning Resources
 │
 ▼
Interactive Results Dashboard
```

---

## 🛠️ Tech Stack

### Frontend

* Vanilla JavaScript
* HTML5
* CSS3
* Responsive UI
* Custom design system
* Dark / light theme support

### Backend

* Node.js
* Vercel Serverless Functions
* Groq API
* Structured LLM output validation

### Development

* Git
* GitHub
* Vercel
* Node.js
* Automated test suite

---

## 🔐 Security

Nova AI is designed with security in mind.

* API credentials are stored in environment variables.
* `.env` files are excluded from version control.
* Learning-resource links never come from the model. Each skill gap is matched in code to a catalogue of checked pages (`resource-links.js`, 22 entries such as the Docker get-started guide, the Pro Git book, the Python tutorial, Google's ML crash course); the card shows that page, labelled "Verified page". A gap with no catalogue entry gets a labelled Coursera search-results link for the gap's own words, and a gap that is gained through work rather than a course (internships, years of experience) gets no link. The model's resource titles and URLs are ignored entirely; only its skill names are read. `safeResourceUrl` (host/provider whitelist) remains for callers that still hold a model URL.
* Third-party scripts (pdf.js, html2pdf, lucide) are self-hosted in `vendor/` with recorded SHA-256 hashes, and the CSP allows scripts from this origin only.
* Rate limiting is shared across serverless instances when Upstash Redis is configured (see below); otherwise it falls back to a per-instance limiter, which does **not** protect your Groq quota on Vercel.
* Dangerous URL schemes such as `javascript:` and `data:` are rejected.
* External links use `noopener noreferrer`.
* Security headers are configured through Vercel.
* User-facing analysis does not expose the underlying API key.
* **Untrusted text never shares a channel with instructions.** Your profile, the opportunity text, requirement text and the verified assessment are sent to the model as a single JSON object in the `user` message; the `system` message holds only fixed instructions that say that object is data, not commands. JSON encoding escapes quotes, backslashes and newlines, so pasted text cannot close a delimiter or add fields (there are no in-band tags to break out of). This is a boundary, not a guarantee that a model can never be persuaded by wording inside the data: the guarantees that matter are enforced in code (evidence quotes must exist verbatim in your text, the verdict and statuses are computed in code, and responses are schema-filtered). See `lib/prompts.js` and `test/prompt-injection.test.js`.
* **Generated writing cannot restate your facts differently.** Insights, the cover letter, interview answers and the matcher's explanations are checked in code (`lib/guards.js`) before they are shown. Metrics are treated as structured evidence (`lib/metrics.js`): exact representation including decimals and the % sign, metric type (accuracy, ROC-AUC, recall, CGPA and similar) and, when the profile's layout shows it, the project (recognised layouts: "Name project:", a heading or title line followed by bullets, "Name — metrics", "Name | stack or dates", "Name (stack)"; metrics in prose, or under a title in another layout, get exact-representation and type checks but no project check, so a swap between such projects is not detected). Metric types come from a fixed list of labels. A generated figure must be the same claim, so a rounded, truncated, re-typed or re-attributed metric (0.7738 shown as 0.7744, 79.4% as 79%, accuracy 91.2% moved to another project) is withheld, not displayed. The analysis also returns `verifiedMetrics`, copied from your profile and shown under Strengths exactly as you wrote them. Graduation compatibility and work-authorization context are computed from your texts and passed to the model as facts; the analysis response also carries deterministic `constraintNotes` that drive "Biggest concern" and "Next best action" whenever a hard requirement failed or is unverified. While a hard requirement has failed, text proposing a different year or cycle as the fix is removed, and visa-route advice (CPT, OPT, F-1, H-1B and similar) is removed unless your profile states US study or status, and telling you that you are eligible for a route is removed unless your profile states that route. Work authorization is never inferred from nationality, location or degree; a sentence that states a wish, plan or absence does not count as a status. These are pattern-based checks: they withhold text that fails them (sometimes text that was actually fine), they do not prove the remaining text is right, they have only been tested against simulated model output, and they never change the verdict or score. Whether the opportunity itself requires work authorization is read with negation in mind (`classifyWorkAuthorization`): "No visa requirements" and "No sponsorship required" are not requirements, "Must be authorized to work in India" is, and implied or conflicting wording ("Sponsorship is not available") is `unknown`; location alone never makes it required. Where a claim about the opportunity came from is checked in code (`lib/provenance.js`): a document is shown under "From the opportunity" only if the quoted text is found in the opportunity and is about that document, everything else is "Suggested by Nova", shown as documents Nova could not confirm from the opportunity text (including saved reports from before this existed, and documents the organiser did ask for when the model's quote did not match the posting); a deadline is shown only if its month and numbers appear in the opportunity, otherwise it is omitted; timing risks are dropped when the opportunity states no date. The "hidden requirements" feature was removed because it only produced unverifiable guesses. A model reply that stops on the output-token limit (`finish_reason=length`), or that lacks any report section, is rejected with a retryable error instead of being shown partially. Preferred requirements: lines under an explicit "Preferred", "Nice to have", "Bonus" or similar heading in the posting are recovered in code when the extractor leaves them out (the same posting gave 5 requirements in one run and 9 in the next); they are added only as preferred, with the posting line as their quote, and an extracted item whose quote comes from that section is never hard or mandatory. Offer lines (stipend, perks) are skipped; a preferred item written as prose rather than a list line still depends on the model. Hard requirements (F2): `hardEligibility` is a pass/fail gate about who the applicant is or their status (age, citizenship or location, work authorization, enrolment, degree level or year, graduation window, minimum grade, a human language, availability). A skill, tool or programming-language proficiency, amount of experience, or completed project is mandatory but never hard, even if the posting says "must" or "required" or lists it under an "Eligibility" heading, unless the posting itself says that lacking it makes an applicant ineligible or disqualified. The extraction prompt says so, and `lib/classification.js` enforces it in code as a downgrade-only backstop: a hard item whose wording is clearly a skill, experience or project criterion, with no gate signal and no explicit disqualifier in its own sentence or the next one, becomes mandatory (never promoted, recorded in `_evidenceTrace.reclassifiedRequirements` with `reason: "skill-or-experience"`). This is lexical: mixed wording (a degree and a skill in one item), wording it cannot judge, and a disqualifier stated elsewhere in the posting keep the model's flag, and a skill named without any capability cue or listed technology is not recognised. Because such items now carry weight 2 instead of 3 and can no longer fail the hard gate, fit scores for postings that listed them as hard move down and a skill gap no longer produces "Not eligible"; the formula and weights are unchanged. The analysis returns `requirementsMatch` with required (hard + mandatory) and preferred tiers, status counts and percentages, plus the fit-score arithmetic and an evidence-coverage explanation; eligibility, requirements match and evidence coverage are three different questions and are shown as such (evidence coverage is the share of statuses that rest on a verified profile quote, not confidence in the verdict). The fit-score formula is unchanged. Claims about the candidate are checked in code (`lib/claims.js`) in resume suggestions, strengths, resume highlights and the profile summary: ownership, outcome, adoption, proficiency and experience words must appear in a non-negated clause of the profile (a skill in a skills list is a listed skill, not proficiency); anything the profile says the candidate lacks ("No experience with cloud platforms or Docker") cannot be claimed; strengths, highlights and summary items must be made of words from the profile (strengths and highlights may also use the opportunity's words); a resume suggestion must quote a verbatim `current` bullet and may not add proper nouns, technologies or hyphenated terms that are not in the profile or that bullet. Failing items are withheld, never rewritten; an empty list is acceptable. These checks are lexical and sometimes withhold text that was fine. Learning links are provider sites, shown as "Suggested search" with an "Open provider site" link; Nova does not claim a specific course page exists.
* **Saved history is retention-limited.** Your last 10 reports are kept in this browser's `localStorage` (key `ocopilot-history`) and nowhere else. Each entry gets a save time and an expiry **30 days later**; expired, malformed and unreadable entries are deleted when the page loads and again before anything is displayed or restored. You can delete one entry or clear everything at any time. Entries saved by earlier versions (no expiry field) are migrated on first load: the save time is recovered from the entry id, so one older than 30 days is deleted, and any other gets the remainder of its 30 days (an id that is not a plausible timestamp gets a full 30 days from migration). `localStorage` is **not encrypted** and is readable by anyone who can use this browser profile or by script on this origin; Nova states this in the interface. There is currently no history export. Stored reports include the evidence quotes and drafted text from your inputs, so treat them as personal data. The history panel ("Saved on this device") sits below the workspace and the report, so saved analyses can be reopened or deleted straight after a reload without running a new analysis.

The production API key is stored as a sensitive Vercel environment variable and is never committed to this repository.

---

## 🧪 Testing

The project includes automated tests and syntax validation.

Run the syntax checks:

```bash
npm run check
```

Run the test suite:

```bash
npm run test
```

Current test status:

```text
322 tests
322 passed
0 failed
```

### Real-browser PDF export tests

`npm test` runs only the Node unit tests (the 322 above) and does **not** start a browser. The PDF export is
additionally covered by a separate suite in `test-browser/` (PDF export plus saved-history retention) that drives real Chromium against the real, vendored
html2pdf.js (the library is never stubbed; only the `/api/*` calls are mocked, and failures are injected into the
browser's canvas APIs). Run it separately:

```bash
# once: install the browser tooling without adding it to package.json
npm install --no-save playwright@1.63.0
npx playwright install chromium          # on a fresh Linux box: npx playwright install --with-deps chromium

# every time
npm run test:browser
```

- Tested with Playwright 1.63.0 and its matching Chromium build (Chromium only; Firefox/Safari are not covered).
- Needs no API key and no network beyond the one-time browser download. It starts `local-dev.js` on a free port.
- It takes about a minute, which is why it is not part of `npm test`.
- Playwright is deliberately **not** a dependency: it is a large install (the browser download is hundreds of MB) that
  the deployed app does not need, and adding it to `package.json` would make every `npm install`, including Vercel's,
  pay for it. The trade-off is that the suite is not run automatically; run it before changing `exportPdf()`,
  `prepareCloneForPdf()` or `vendor/html2pdf.bundle.min.js`.

---

## 💻 Run Locally

### 1. Clone the repository

```bash
git clone https://github.com/Mk-Zone14/nova-ai.git
cd nova-ai
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy `.env.example` to `.env.local` and fill in your key:

```env
GROQ_API_KEY=your_groq_api_key
```

Optional, recommended in production: set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (a free Upstash Redis database works) so the rate limit is shared across all serverless instances. Add the same variables to Vercel for Production and Preview.

How the limiter identifies a client:

* **On Vercel** it uses the platform-set `x-vercel-forwarded-for` header (falling back to `x-real-ip` / `x-forwarded-for`). This relies on Vercel's system environment variables being exposed to functions (the project default), because the limiter checks the `VERCEL` variable to decide whether to trust those headers.
* **Everywhere else** (local dev, other hosts) forwarding headers are **ignored** and the socket address is used, because otherwise a caller could send a new `X-Forwarded-For` on every request and never be limited. Behind your own reverse proxy that means all clients share the proxy's address.
* IPv6 clients are grouped by /64 prefix; invalid addresses are discarded. With no usable address at all, clients are separated by a hash of the user-agent and language headers instead of sharing one bucket.
* Limits: 10 analyses and 20 narrative sections per client per minute (fixed window, so a short burst across a window boundary can briefly reach double). Rate-limit responses are a generic message plus `Retry-After`.
* If Redis is unreachable the limiter fails **open** to the per-instance fallback (so an outage cannot take Nova down), logs the error type once a minute, and the fallback is weaker. Without the two variables on Vercel it logs a one-time warning that limiting is per-instance only.
* `UPSTASH_REDIS_REST_URL` must be `https://`; plain `http://` is accepted only for a loopback emulator.

### 4. Start the development server

```bash
npm run dev
```

The local development server will start using the project's Node.js development configuration.

---

## 📁 Project Structure

```text
nova-ai/
│
├── api/
│   ├── analyze.js       # verdict (extract → match → compute)
│   └── narrative.js     # on-demand insights / cover letter / interview
├── lib/                 # eligibility core, prompts, rate limiter
├── vendor/              # self-hosted third-party scripts + hashes
│
├── test/
│
├── client.js
├── index.html
├── styles.css
├── brand-theme.css
├── features.css
├── premium.css
├── refined.css
├── motion.css
├── disclosure.css
├── launch-button.css
├── print.css
├── theme-init.js
├── resource-links.js
├── report-model.js      # pure report logic + markup builders (unit-tested)
│
├── local-dev.js
├── package.json
├── vercel.json
├── .env.example
├── .gitignore
└── README.md
```

---

## 🔄 Analysis Pipeline

The verdict and score are computed **in code**, not by the model. The LLM only proposes requirements and statuses; the server verifies them.

1. **Extract** — the model lists the opportunity's requirements, each flagged `mandatory` and `hardEligibility`, with a verbatim `sourceQuote`. Requirements whose quote isn't found in the opportunity text are dropped.
2. **Match** — the model assesses each requirement against the profile and must quote the supporting profile text. The server checks the quote is verbatim; otherwise `Matched`/`Partial Match` is downgraded to `Unknown`. A *hard* requirement can only be `Missing` with a verified contradicting quote — absence from a resume is not proof of ineligibility.
3. **Compute** (`lib/eligibility.js`, pure and unit-tested):
   * Any hard requirement `Missing` → **Not eligible**
   * Otherwise any hard requirement `Unknown`/`Partial Match` → **Needs verification**
   * Otherwise → **Eligible**
   * Fit score = weighted share of earned credit (hard ×3, mandatory ×2, preferred ×1; Matched = 1, Partial = 0.5, Missing/Unknown = 0)
   * **Evidence coverage** = % of requirements backed by a verified quote
4. **Narrative (on demand, separate endpoint `/api/narrative`)** — the verdict is returned after steps 1–3 only (two model calls), so it appears within seconds. The browser then loads **insights** (strengths, gaps, risks, documents, resources, resume/ATS feedback) automatically in the background, and generates the **cover letter** and **interview questions** only when you click the button. Each section is told the computed statuses are final and cannot set the verdict or any score. The browser sends the verified verdict and requirement statuses back with each request; the server re-validates that payload (shape, allowed statuses, size) and strips any fields a section isn't allowed to return. If a section fails, the verdict is unaffected and the section can be retried. Your profile and opportunity text are kept in memory only for that, never written to local history, so an analysis restored from history shows what was already generated but cannot generate more.

Known limits: the ATS and resume-strength scores are still model-estimated from the pasted text alone (the model never sees file formatting), can differ between runs on identical input (observed spread of about 4 points), and do not affect the verdict or the fit score; and "Eligible" with zero hard requirements flagged means nothing disqualifying was *checked*, not that nothing exists. Always confirm against the official criteria.

---

## 📚 Learning Resources

When skill gaps are identified, Nova AI can recommend resources to help candidates close those gaps.

Resources may include:

* Online courses
* Documentation
* Tutorials
* Technical learning material
* Open-source contribution guides

Resource links are chosen in code from a catalogue of checked pages, one per skill gap; the model never supplies a URL or a course title. Gaps without a catalogue entry get a labelled search link or no link.

---

## 🎨 Design

Nova AI uses a minimal, application-focused interface designed around:

* Clear information hierarchy
* High signal-to-noise ratio
* Responsive layouts
* Dark and light themes
* Accessible interactive states
* Compact analysis cards
* Structured result sections
* Mobile-friendly horizontal resource scrolling

The interface is intentionally designed to feel more like a serious career intelligence tool than a generic AI chatbot.

---

## 🚀 Deployment

Nova AI is deployed on Vercel.

Production deployment:

**[https://nova-ai-delta-five.vercel.app/](https://nova-ai-delta-five.vercel.app/)**

The GitHub repository is:

**[https://github.com/Mk-Zone14/nova-ai](https://github.com/Mk-Zone14/nova-ai)**

### Function time limits (Vercel Hobby)

`vercel.json` gives both API functions `maxDuration: 60`. Per Vercel's documentation, Hobby allows up to 300 s when Fluid compute is enabled (the default for projects created after April 2025) and up to 60 s when it is not, so 60 s is valid either way. Do not raise it above 60 without confirming Fluid compute is on for the project (Project Settings → Functions).

The time budgets are layered so the failure you see is always ours, not the platform's:

| Layer | Limit |
| --- | --- |
| Single model call (`analyze` / `narrative`) | 45 s |
| Server budget per request | 50 s (`analyze` runs two calls inside it) |
| Vercel `maxDuration` | 60 s |
| Browser timeout | 65 s (sections) / 75 s (analysis) |

`test/quality.test.js` fails if these drift out of order. To confirm what a deployment actually applied, run `vercel inspect <deployment-url> --json` and read each function's `timeout`.

### Verifying the real Groq integration

The automated tests use a mocked provider, so they prove our handling of Groq's responses, not the model's behaviour. To check the real thing yourself:

```bash
GROQ_API_KEY=<your key> npm run verify:groq        # optional: GROQ_MODEL=<model id>
```

It runs the bundled sample profile and the Atlas Labs internship through the production handlers: two model calls for the verdict, then one call each for insights, cover letter and interview prep (five calls in total). It refuses to run without a key and never prints it. Each call also logs one line (`Groq call ok: model=… ms=… prompt_tokens=… completion_tokens=… finish=…`), so you can read real latency and token cost. The same line appears in the Vercel runtime logs in production (Hobby keeps logs for one hour).

The script exits non-zero on any `FAIL`. What it checks, and what only you can judge:

| Automatic | You must read it yourself |
| --- | --- |
| HTTP 200 per call and latency against the 50 s budget | Whether each requirement's status matches what the profile actually says (the table it prints) |
| Verdict is a known value, 3+ requirements extracted | Whether the cover letter is honest and sounds like the student |
| Every requirement quote exists in the opportunity text | Whether interview answers are specific rather than generic |
| Every Matched/Partial evidence quote exists in the profile | Whether any learning-resource URL looks invented |
| How many of the model's claims the code downgraded (a high count means overclaiming) | |
| Cover letter length, `[placeholders]`, skills absent from the profile (heuristic) | |

Things worth trying only after a baseline run, one at a time and re-running the script each time: a lower reasoning effort or a smaller `GROQ_MODEL` if latency is near the budget. Neither has been tested here.

---

## 🗺️ Roadmap

Potential future improvements include:

* [ ] Resume file upload and parsing
* [ ] Persistent candidate profiles
* [ ] Opportunity bookmarking
* [ ] Application tracking
* [ ] More sophisticated evidence extraction
* [ ] Opportunity discovery
* [ ] Personalized application timelines
* [ ] Better probability calibration
* [ ] More learning-resource providers
* [ ] Authentication and user accounts
* [ ] Application history and analytics

---

## ⚠️ Disclaimer

Nova AI provides AI-generated analysis and recommendations.

Eligibility decisions, acceptance probabilities, and other assessments should be treated as **decision-support information**, not guarantees.

Always verify eligibility requirements against the official opportunity documentation before applying.

---

## 📜 License

This project is currently intended as a personal/portfolio project.

All rights reserved unless otherwise specified.
