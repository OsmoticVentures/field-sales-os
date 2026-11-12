/**
 * GENERATED FILE, DO NOT EDIT.
 *
 * Source: nutribiotic/config/meeting_asks.json in the agency repo: the clock times and
 * meeting lengths Juan wrote himself in sent mail, each with its line. The composer may
 * propose them, and the number check lets these exact phrases through.
 * Regenerate with `python3 scripts/sync_email_voice.py`.
 */

export type MeetingPhrase = { phrase: string; use: string; quote: string };

export const MEETING_TIMES: MeetingPhrase[] = [
  {
    "phrase": "10am",
    "use": "the default, a morning visit",
    "quote": "How is Wednesday 21st at 10am for you?"
  },
  {
    "phrase": "1pm",
    "use": "when the note says afternoons work best",
    "quote": "Let's coordinate for next week: are you available Tuesday 27th at 1pm?"
  }
];

export const MEETING_LENGTHS: MeetingPhrase[] = [
  {
    "phrase": "30 minutes",
    "use": "a staff training, said as 'no longer than 30 minutes'",
    "quote": "I intend for us to take no longer than 30 minutes, so you will have time to prepare for the day after our meeting."
  },
  {
    "phrase": "5 minutes",
    "use": "a short in-person introduction at a clinic or a busy office",
    "quote": "I like to come in for 5 minutes to make an introduction and then coordinate over email."
  }
];
