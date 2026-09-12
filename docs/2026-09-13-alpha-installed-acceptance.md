# Alpha 0.1.14: installed acceptance, 13 September 2026

## Scope and current result

Local Alpha only. Stable, Dev, the public release feed, shared production gateway
and payment infrastructure are unchanged by this update. This is **not a Stable
release approval**. Account login, cross-device subscriptions and device limits
remain unimplemented pending a separately scoped account service and mail delivery.

Candidate `cad15ae659b4fc9f7c57ae7aae79c6c67b92dd2f` built successfully and was
installed as `0.1.14-alpha.gcad15ae6`. Windows uninstall metadata confirmed the
full version. The first installed acceptance found additional defects; this
candidate did **not pass overall acceptance**. Corrective build
`0.1.14-alpha.g1109208c` is now installed and passed the focused installed checks:
**10/10 voice turns, 3/3 screen scenarios, Electron recording/UI smoke**. It is
ready for the owner's manual Alpha testing, not a public Stable promotion.

## Confirmed source checks before the first installation

- Desktop: 161 test files, 1533 tests passed.
- Desktop TypeScript and Electron TypeScript checks passed.
- Backend chat, candidate profile, fast context and screen pipeline: 126 tests
  passed; five existing framework deprecation warnings.
- Source Electron overlay test passed its two screen requests. Its deliberately
  incomplete health stub emitted document CORS warnings; this was not a full
  candidate-profile UI acceptance.
- Focused deterministic tests cover ten question/final/answer lifecycles, lost
  final events, hard expiry and recovery. These are not acoustic test results.

## First installed checks

- Electron: main window, open overlay, enabled recording button, live recording,
  recording stop and outside-click menu close all passed.
- Real voice series: **failed twice on turn 4**, after three completed answers
  in the same STT connection. No restart between questions and no weakening of
  final-request correlation or semantic checks.
- Metadata-only diagnosis: the real-time recognizer returned the fourth question
  as an unforced final; the forced request later returned an empty low-quality
  final. Offline replay through the production Endpointer found an automatic
  commit followed by a 473 ms residual tail with RMS 141. The manual detection
  threshold of 50 classified that tail as pending audio; force targeted the tail
  instead of the unresolved full question. The deterministic regression and
  correction described below were added before repeating acceptance.
- Structured screen suite: **1/3 passed overall**. SQL passed all checks. GitLab
  retained both frames' findings but first output took 32,984 ms. Checklist output
  took 31,187 ms and failed `all_three_genuinely_new`. Latency gates were not raised
  and semantic failures were not ignored.
- Screen metadata report:
  `output/verification/real-interview-overlay/screen-alpha-0.1.14-installed.json`.

The WAVs and screen tasks are repository fixtures. Verifier databases use an
existing paid identity without copying the user's resumes or transcripts.
Provider checks consume that identity's allowance. Passing those tests would not
prove operation on every ordinary customer tariff or physical hotkey delivery.

## Corrections discovered during acceptance

- Voice: deterministic bridge and Endpointer tests reproduce residual noise
  stealing force ownership. Correction uses the already-observed trailing noise
  floor for manual pending-audio classification, without replaying a transcript.
  It retains independent loud/quiet new speech and late-final isolation controls.
- Checklist: a separate deterministic false negative was proven. Candidate text
  discarded underscores before concept comparison while previous items retained
  them. Two near-identical `payment_method` scenarios scored 0.2857 in production
  and 0.6 in the independent acceptance scorer (unchanged limit 0.45). Commit
  `f12344f` makes tokenization symmetric and adds a full refinement/repair
  regression. This is not conclusive evidence of the particular live failure's
  cause; its private-content-free report cannot show that distinction.
- Neither correction proves uniformly low screen latency. Source tests alone
  cannot clear an acceptance failure; the fresh result below covers one run.

## Corrective source and installed identity

Source: `1109208cbb6afc3e406474f76b88a3c3e1d44ac9`. Independent review approved the
five-file correction range without actionable P1/P2 findings. Root reran:
1533 desktop tests, 225 backend STT/chat/context/screen/state tests, 42 verifier
tests, desktop and Electron typechecks. All passed. The first backend invocation
contained a nonexistent test filename and ran no tests; 225 is the corrected run.

The new installer completed with exit0. Windows uninstall metadata reports
`0.1.14-alpha.g1109208c`. Both installed `app.asar` and backend EXE match the exact
packaged files. The installed Electron recording/UI smoke passed again.

| Artifact | SHA256 |
|---|---|
| Alpha installer | `23C492B21BE884CECDC6ED3EA426821DC5B12F4F48540E01A8CA99E1FA08E4C9` |
| Installed app.asar | `05E66708B47F17E0857896C3F7429DB53174B21A3529052339683892ACE11499` |
| Installed backend EXE | `55CD8C9D2BFCD85AA84012EE79B165F6D4C8B2D3E55370D1ECBEB0EBB970BAED` |

Installer: `apps/desktop/release-alpha/SkillCue-Alpha-Setup.exe`.
This local installer is unsigned; no Windows signing certificate is configured.
No public release was published.

## Corrective installed screen acceptance

**3/3 passed**, unchanged gates, no request retry: GitLab frame continuity,
minimal SQL refinement and checklist novelty. First visible output took
29,640 ms, 9,968 ms and 25,328 ms respectively. All scenario semantic checks
passed. This single three-scenario run does not prove consistently fast screen
answers; the earlier slow run remains recorded. The extended nine-attempt run
and a 95-minute soak were not repeated on this build.

Report:
`output/verification/real-interview-overlay/screen-alpha-0.1.14-g1109208c-installed.json`.

## Corrective installed voice acceptance

The first corrective run got past the fourth STT operation and produced an
answer, but failed the answer keyword gate. Two isolated fixture probes showed
`изолировали` and `повторный запуск` in a substantive answer; the fixture matched
only `логи` and `Allure` because its alias lists lacked those Russian forms.
A focused verifier regression and exact synonym additions in `709c63b` fixed that
false negative. A diagnostic-only full ten-turn run then completed all ten answers
but remained failed for case05: the Page Object answer used inflected Russian
phrases for five concepts absent from the alias lists. Commit `68777fa` added
those exact equivalents with positive and negative matcher tests. Both fixture
changes passed independent review. Application code, the required three matched
concepts, ten completed turns, deadlines and force correlation remained unchanged.

**Final unchanged strict verifier: exit0, completed=10, passed=true.** One backend
and STT WebSocket stayed open for all ten turns; six distinct WAVs plus four
repeated questions. Every answer completed and passed its transcript/answer
concept checks. Trigger-to-first-answer: **1,484–2,719 ms**; STT after trigger:
797–1,297 ms. These fixture results do not establish microphone acoustics or every
future model answer's correctness. Final focused verifier tests:44 passed;
implementer full tools suite:339 passed.

Metadata-only report:
`output/verification/real-interview-overlay/voice-alpha-0.1.14-g1109208c-installed.json`.
Packaged application source remains `1109208`; the later two commits change only
repository fixture aliases and their tests, not installed application bytes.

## Protected installations and data

Hashes before and after both Alpha installations match exactly:

| Application | Windows version | SHA256 of installed EXE |
|---|---|---|
| Stable | 0.1.12.0 | `81D8BDA6C5229E62C4FCFA0940DD9EF5927045167B2B0C87AEFD67A1AB785C5F` |
| Dev | 0.1.11.0 | `D16F9F4FF8189A5C37677ADA3924A933DF94C819229FD1B3B337BF6C72240866` |

Full Alpha data backup, made while Alpha was stopped:
`output/backups/alpha-before-update-20260913-020631/SkillCue Alpha`.
No Dev data was copied into Alpha. Before testing, Alpha had no resume documents
or saved candidate profile pack. Add your own facts in «Профиль и опыт» to test
personal-project answers; the application must not invent absent experience.

## Manual check after the corrective build

Close other SkillCue variants before checking shared physical shortcuts. Open
Alpha's overlay with Ctrl+Shift+H, choose «Только микрофон» for your own voice,
start recording, then ask ten questions and
request each answer with Ctrl+Enter. Include a follow-up about the same project
and an unrelated theory question. Ctrl+Shift+Enter checks the screen. Screen
continuity remains experimental; earlier failures remain in this report even
after the final passing run. Physical global hotkeys have not been exercised by
the automated backend/recording tests. Automatic final app launch was blocked by
the execution tool; open the SkillCue Alpha shortcut yourself. The installer and
test launches succeeded; Alpha is not claimed to be left running.
