# Launch blog

The blog is the long-form home for the project. Posts and HN point here; the deck and video summarise it. Write it so it can be published as one piece or split into a four-part series (sections 1 to 4 below each stand alone).

## Front matter

```yaml
---
title: "<Project>: <what it does>, built in a day and tested in a real browser"
description: "<under 160 characters, includes the product category, 'OpenAI' and 'Kane CLI'>"
date: <YYYY-MM-DD>
authors: [<names>]
tags: [kane-cli, openai, hackathon, <domain>]
canonical: <url or TODO>
hero: <suggested image: the annotated screenshot of the step that failed, or the app's main screen>
---
```

Title under 70 characters for search. Description is what shows on X and LinkedIn cards; write it as a sentence a person would click.

## TL;DR

Three sentences directly under the title: what it is, what it is built with, what the proof is (link to the evidence pack or Ship Page).

## Section 1: What we built

- Open with the problem as a scene, in the author's voice. Two paragraphs max.
- The pitch in one sentence.
- Who it is for and who it is not for.
- Demo link and a hero screenshot or the showcase video embedded.
- The hack day context (event, time limit, team) in one paragraph. Say "built with OpenAI, tested with Kane CLI" once here.

## Section 2: Use cases

Three to five, each a short scenario with a named role ("a release manager at a 40-person startup"), the trigger, what the project does, and the outcome. Use H3 headings. Prefer the cases the team actually tested over hypothetical ones; mark hypotheticals as "we have not tried this yet".

## Section 3: How we built it

- Architecture in prose first, then an optional diagram (Mermaid block or an image from the deck).
- The OpenAI layer: which model, which API surface (Responses, Agents SDK, Realtime, Codex), what it is responsible for, prompt or tool design decisions in two or three sentences each. Include one code snippet of 10 to 25 lines if it clarifies.
- Decisions and tradeoffs: two or three things you chose against and why.
- What the agent (Codex, Claude Code, Cursor) wrote versus what the humans wrote. Be specific. Readers trust this.

## Section 4: Where Kane CLI changed the build

This is the section that earns the TestMu AI tag. Write it from the evidence pack, not from memory.

Pull from `scripts/evidence_to_storyboard.py` output (`launch/video/storyboard.json`) or directly from the pack:

- `run.yaml`: title, status, started/ended, totals
- `tests/<id>/result.yaml`: verdict, per-step outcomes
- `tests/<id>/steps/<n>-<id>/step.json` and `annotated.png`: the exact step and screenshot
- `tests/<id>/steps/<n>-<id>/failure.yaml`: error and page state for the failed step

Structure:

1. The loop: how the team ran Kane CLI during the build (the actual command with `--agent`, how often, who read the output). One or two paragraphs.
2. The first failure: the objective string, the step that failed, the annotated screenshot, what the failure record said, what the root cause turned out to be, the fix. This is the heart of the post.
3. The pass: the passing run and its totals. Don't link or attach the evidence pack: it stays private (it holds network and console logs).
4. What it changed about how you built: concrete behaviour, like "we stopped eyeballing the staging site and ran the flow after every merge".
5. Limits and honest notes: what Kane CLI did not catch, where it was slow, what you would set up differently.

Link Kane CLI once to https://github.com/LambdaTest/kane-cli and once to the docs. Mention the install command the team used (`npm install -g @testmuai/kane-cli@rc`, the release candidate the hackathon ran on) so readers can repeat the loop.

## Section 5: What's next, try it, credits

- Three next steps, each one line.
- How to run it locally (commands), or the demo URL.
- Credits: teammates with links, the hack day, TestMu AI and OpenAI as text links.
- Link to the Ship Page and deck.

## Style

- 1,400 to 2,200 words total.
- Headings in sentence case.
- Images: alt text that describes the screenshot ("Kane CLI annotated screenshot showing the OTP field highlighted after the failed step 4").
- Apply `humanize.md` before handover.
- No section opens with "In this section".
