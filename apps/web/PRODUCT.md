# Product

## Register

product

## Platform

web

## Users
Curious newcomers first: people who have heard that AI might write software, including software engineers who have never looked below source code. They need the idea explained in plain language before any machinery. Then the experts who will judge the claim (CPU, compiler and systems people, researchers, reviewers), often at talks or on a big screen, one switch away in the expert view. It must convince a newcomer in a minute and survive an expert's questions afterwards.

## Product Purpose
llmtobinary shows that a language model can write literal executable bytes for a virtual instruction set, and that the machine, not the model, manages storage: the same bytes run with fewer fast-value slots and produce the same result with visibly more backing-store traffic. The chip view makes that machinery physically legible, as a floorplan of the hardware a real implementation would need, lit only by events the machine actually executed. Success is an expert watching it and finding nothing faked.

The simple view sells the idea: an AI could write machine code directly, with no source code or compiler, for a processor designed for that (ANMA-1), which would have to be manufactured to exist as a chip. The explainer tells that story step by step; the page then shows an AI-written program's bytes in plain English and runs it. The expert view keeps the full instrument.

## Positioning
The model names values; the hardware decides where they live. Every light on the chip is a real event.

## Brand Personality
A lab instrument: precise, quiet, trustworthy. Closer to an oscilloscope or logic analyzer than a showpiece. Light carries information and nothing is decorative; the confidence comes from exactness, not spectacle.

## Anti-references
- Sci-fi hacker HUDs: neon cyberpunk, glitch effects, fake "matrix" scrolling.
- Toy or cartoon CPUs: rounded playful blobs, mascot energy.
- Decorative light shows: any animation not tied one-to-one to a machine event.
- Generic SaaS dashboards: cards, KPI tiles, gradient accents.

## Design Principles
- Every signal is real: a unit lights only because the machine did that step, and the event is inspectable.
- Honest labels: modeled ticks are never called cycles, the view is a model not silicon, and limits are stated where they apply.
- Legible at distance, exact up close: readable on a projector, with precise values one click away.
- Show, don't tell: the argument (hardware-managed storage vs model-managed spills) is made by watching both run.

## Accessibility & Inclusion
Best effort: sensible defaults.
