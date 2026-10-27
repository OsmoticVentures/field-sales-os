/**
 * GENERATED FILE, DO NOT EDIT.
 *
 * Source: nutribiotic/playbook/sales-playbook.md and practice.json in the agency repo, the
 * one editable copy of the sales playbook. Carries each section's number,
 * title, the status its heading states, and the TODO markers left in it.
 * Regenerate with `python3 scripts/sync_playbook.py`.
 */

export type PlaybookStatus = "tested" | "partial" | "derived" | "proposed" | "untested" | "todo";

export type PlaybookSection = { n: number; title: string; status: PlaybookStatus; note: string; todos: number };

export const PLAYBOOK_TITLE = "Sales Playbook · v0 (skeleton for v1, due 2026-09-30)";

export const PLAYBOOK_SECTIONS: PlaybookSection[] = [
  {
    "n": 1,
    "title": "The territory model",
    "status": "tested",
    "note": "field-tested",
    "todos": 0
  },
  {
    "n": 2,
    "title": "The week",
    "status": "tested",
    "note": "field-tested",
    "todos": 0
  },
  {
    "n": 3,
    "title": "The visit loop",
    "status": "tested",
    "note": "field-tested, keep tightening",
    "todos": 0
  },
  {
    "n": 4,
    "title": "What to lead with, by account type",
    "status": "todo",
    "note": "TODO: fill from field evidence",
    "todos": 0
  },
  {
    "n": 5,
    "title": "Objection handling",
    "status": "todo",
    "note": "TODO: build as they occur",
    "todos": 0
  },
  {
    "n": 6,
    "title": "Reactivation motion",
    "status": "partial",
    "note": "partially tested",
    "todos": 1
  },
  {
    "n": 7,
    "title": "Tools of the trade",
    "status": "tested",
    "note": "field-tested",
    "todos": 0
  },
  {
    "n": 8,
    "title": "New-account prospecting kit",
    "status": "proposed",
    "note": "proposed, not built, awaiting go-ahead",
    "todos": 0
  },
  {
    "n": 9,
    "title": "Weekly action checklist",
    "status": "derived",
    "note": "derived from Sections 1-3, 6, 7 above, not new claims",
    "todos": 3
  },
  {
    "n": 10,
    "title": "Plameca's own sales meeting framework",
    "status": "untested",
    "note": "borrowed, not yet field-tested",
    "todos": 0
  }
];

export type RoadmapStage = { key: string; title: string; section: number; say: string; points: string[] };

export type Drill = { id: string; stage: string; cue: string; line: string };

export const SALE_ROADMAP: RoadmapStage[] = [
  {
    "key": "before",
    "title": "Before the door",
    "section": 3,
    "say": "call ahead, then send a reminder email",
    "points": [
      "read the account dossier on the phone",
      "what they buy, what they stopped buying, last order, named contact, potential grade"
    ]
  },
  {
    "key": "open",
    "title": "Open",
    "section": 10,
    "say": "name yourself as a new rep, and the reason for the questions is understanding the client better in order to serve them",
    "points": [
      "With older, experienced retailers: open with \"help me learn\" instead of a pitch.",
      "sell to the person named in the dossier if there is one; otherwise the first job of the visit is to leave with a name and role"
    ]
  },
  {
    "key": "story",
    "title": "Company story",
    "section": 10,
    "say": "I'm here to help, GSE brings clarity.",
    "points": [
      "NutriBiotic (GSE) is 42 years old, ATP Farma is 40, \"two companies\" built on real formulation history",
      "expert in effective compounds, from our own cultivation through to our own R&D"
    ]
  },
  {
    "key": "need",
    "title": "Generate the need",
    "section": 10,
    "say": "Generate the need before talking about the product at all.",
    "points": [
      "Ask whether the person is tired physically or mentally"
    ]
  },
  {
    "key": "minute",
    "title": "Golden minute",
    "section": 10,
    "say": "explain how the product covers that need, its actual benefits",
    "points": [
      "we look after the account's business, our products work together (the basis for cross-selling), effective with clear benefits",
      "Cross-selling means personalized treatments, not a single SKU."
    ]
  },
  {
    "key": "help",
    "title": "Help them sell",
    "section": 10,
    "say": "give the buyer what they need to place the product with their own customers, not just to stock it",
    "points": [
      "Train the staff to recommend the product, not just to stock it.",
      "better margin and staff loyalty to the brand versus buying online"
    ]
  },
  {
    "key": "novelty",
    "title": "Novelty and promotion",
    "section": 10,
    "say": "lead with whatever's new this trip and its specific benefits",
    "points": [
      "A concrete reason to buy this week, not \"sometime.\""
    ]
  },
  {
    "key": "gaps",
    "title": "Top sellers and restock",
    "section": 10,
    "say": "Check the dossier for what's missing",
    "points": [
      "Only works when the number is real for that product",
      "overdue-active gets a reorder ask on what they already buy"
    ]
  },
  {
    "key": "after",
    "title": "After the door",
    "section": 3,
    "say": "log the visit as a HubSpot company Note",
    "points": [
      "Follow-ups become calendar proposals, human-approved."
    ]
  }
];

export const DRILLS: Drill[] = [
  {
    "id": "story-close",
    "stage": "story",
    "cue": "You finish the company story. The closing line, word for word.",
    "line": "I'm here to help, GSE brings clarity."
  },
  {
    "id": "story-history",
    "stage": "story",
    "cue": "Tell the company story in one breath.",
    "line": "NutriBiotic (GSE) is 42 years old, ATP Farma is 40, \"two companies\" built on real formulation history."
  },
  {
    "id": "credibility",
    "stage": "story",
    "cue": "The credibility claim, before any product talk.",
    "line": "expert in effective compounds, from our own cultivation through to our own R&D"
  },
  {
    "id": "open-new-rep",
    "stage": "open",
    "cue": "First minute with a new buyer. Why are you asking all these questions?",
    "line": "name yourself as a new rep, and the reason for the questions is understanding the client better in order to serve them and to shape better products around what the market is actually asking for"
  },
  {
    "id": "open-veteran",
    "stage": "open",
    "cue": "An older, experienced retailer. How do you open?",
    "line": "open with \"help me learn\" instead of a pitch"
  },
  {
    "id": "dont-know",
    "stage": "open",
    "cue": "They ask something you cannot answer on the spot.",
    "line": "I know people at my company who can answer that"
  },
  {
    "id": "need-first",
    "stage": "need",
    "cue": "What comes before any product talk?",
    "line": "Generate the need before talking about the product at all."
  },
  {
    "id": "tired",
    "stage": "need",
    "cue": "A customer says they are tired. The routing question and where each answer goes.",
    "line": "Ask whether the person is tired physically or mentally: physical tiredness routes to the general line, mental tiredness routes to the Clarity+ product"
  },
  {
    "id": "three-part",
    "stage": "minute",
    "cue": "The three-part pitch.",
    "line": "we look after the account's business, our products work together (the basis for cross-selling), effective with clear benefits"
  },
  {
    "id": "therapy",
    "stage": "minute",
    "cue": "Why sell a treatment and not a single product?",
    "line": "A single product sold on its own is less effective and doesn't read as a personalized therapy, at which point there's no reason for the buyer not to just order it online."
  },
  {
    "id": "staff-training",
    "stage": "help",
    "cue": "The benefit to name when you offer a staff training.",
    "line": "better margin and staff loyalty to the brand versus buying online"
  },
  {
    "id": "partners",
    "stage": "help",
    "cue": "What relationship are you building with the account?",
    "line": "Become business partners, not a vendor relationship."
  },
  {
    "id": "ask-overdue",
    "stage": "gaps",
    "cue": "An active account past its reorder cadence. The ask.",
    "line": "overdue-active gets a reorder ask on what they already buy"
  },
  {
    "id": "ask-dormant",
    "stage": "gaps",
    "cue": "A dormant account. What comes before any pitch?",
    "line": "dormant gets a \"what changed\" conversation before any pitch"
  },
  {
    "id": "ask-prospect",
    "stage": "need",
    "cue": "A prospect who has never bought. What do you open with?",
    "line": "prospect gets the fit question first"
  },
  {
    "id": "booking",
    "stage": "before",
    "cue": "How do you book the meeting?",
    "line": "call ahead, then send a reminder email"
  }
];
