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
* Learning-resource links are never taken from the model verbatim: they resolve to a fixed list of known-good URLs by host or exact provider name (`resource-links.js`).
* Third-party scripts (pdf.js, html2pdf, lucide) are self-hosted in `vendor/` with recorded SHA-256 hashes, and the CSP allows scripts from this origin only.
* Rate limiting is shared across serverless instances when Upstash Redis is configured (see below); otherwise it falls back to a per-instance limiter, which does **not** protect your Groq quota on Vercel.
* Dangerous URL schemes such as `javascript:` and `data:` are rejected.
* External links use `noopener noreferrer`.
* Security headers are configured through Vercel.
* User-facing analysis does not expose the underlying API key.

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
61 tests
61 passed
0 failed
```

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
│   └── analyze.js
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
4. **Narrative** — cover letter, roadmap, interview questions, resources and resume feedback are generated last, told the computed statuses are final, and cannot set the verdict or any score. If this step fails, the verified verdict is still returned.

Known limits: the ATS and resume-strength scores are still model-estimated, and "Eligible" with zero hard requirements flagged means nothing disqualifying was *checked*, not that nothing exists. Always confirm against the official criteria.

---

## 📚 Learning Resources

When skill gaps are identified, Nova AI can recommend resources to help candidates close those gaps.

Resources may include:

* Online courses
* Documentation
* Tutorials
* Technical learning material
* Open-source contribution guides

Resource links are validated before being rendered as clickable external links.

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
