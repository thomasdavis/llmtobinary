// "What is this?" — the explainer shown on a first visit and reopened from the header. Written for
// people who have never looked below source code, and kept strictly honest: ANMA-1 is a design,
// not a chip you can buy, and everything the site shows is labelled as simulated or modeled.

import { useEffect, useRef, useState, type ReactNode } from "react";

export type IntroAction = "watch" | "ask" | "explore" | "os";
type Step = { title: string; body: ReactNode };

function Flow({ steps }: { steps: { label: string; detail: ReactNode; note?: string; struck?: boolean; accent?: boolean }[] }) {
  return (
    <div className="flow" role="img" aria-label={steps.map((s) => (s.struck ? `no ${s.label}` : s.label)).join(" then ")}>
      {steps.map((s, i) => (
        <div key={s.label} className="flow-step-wrap">
          {i > 0 && <span className="flow-arrow" aria-hidden="true">→</span>}
          <div className={`flow-step${s.struck ? " is-struck" : ""}${s.accent ? " is-accent" : ""}`}>
            <span className="flow-label">{s.label}</span>
            <span className="flow-detail">{s.detail}</span>
            {s.note && <span className="flow-note">{s.note}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

const STEPS: Step[] = [
  {
    title: "Computers only understand binary",
    body: (
      <>
        <p>
          A computer's processor (its <strong>CPU</strong>) doesn't read Python or JavaScript. It reads <strong>binary</strong>: a list of numbered instructions, each only a few bytes long, such as “add these two numbers” or “set this pixel”.
        </p>
        <p>
          People write <strong>source code</strong> instead, because people can read it. A <strong>compiler</strong>, a large and carefully engineered program, then translates that source code into binary for the processor.
        </p>
        <Flow
          steps={[
            { label: "Source code", detail: <code>score = score + 1</code>, note: "written by a person" },
            { label: "Compiler", detail: "translates", note: "a program people built" },
            { label: "Binary", detail: <code>20 00 00 00 03 …</code>, note: "what the chip runs" },
            { label: "CPU", detail: "runs it" },
          ]}
        />
      </>
    ),
  },
  {
    title: "What if AI wrote the binary directly?",
    body: (
      <>
        <p>
          AI can already write source code. The next step may be to skip source code entirely: you describe what you want, and the AI writes the processor's instructions itself. No source code, no compiler, just the bytes the chip runs.
        </p>
        <p>
          That is the experiment on this site. Every program the AI makes here is written <strong>byte by byte</strong> by an OpenAI model. A checker tells it about its mistakes, but never writes or fixes a single byte for it.
        </p>
        <Flow
          steps={[
            { label: "Your description", detail: <q>a game with a paddle and a ball</q> },
            { label: "Compiler", detail: "not needed", struck: true },
            { label: "AI model", detail: "writes the bytes", accent: true },
            { label: "CPU", detail: "runs them" },
          ]}
        />
      </>
    ),
  },
  {
    title: "Why we designed a new processor: ANMA-1",
    body: (
      <>
        <p>
          Today's processors weren't built for this. They keep the values they are working on in a few fast storage slots called <strong>registers</strong>, often only 16. Every instruction has to name the exact register to use, and when they are full the program itself must move values out to memory and back again.
        </p>
        <p>Compilers do that bookkeeping for programmers. An AI writing binary by hand would have to get it right on every single instruction.</p>
        <p>
          <strong>ANMA-1</strong> is a processor design that takes that job away. A program simply names each result (value 1, value 2, value 3), and <em>the chip</em> decides where each value is stored, moving values between its fast storage and slower memory on its own.
        </p>
        <div className="compare" role="img" aria-label="An ordinary CPU needs register bookkeeping; ANMA-1 lets the program just name values">
          <div className="compare-col">
            <span className="compare-head">An ordinary CPU: the program says</span>
            <code>put 7 in register 3</code>
            <code>save register 3 to memory</code>
            <code>load it back into register 5</code>
            <code>add register 5 to register 2</code>
          </div>
          <div className="compare-col is-anma">
            <span className="compare-head">ANMA-1: the program says</span>
            <code>v3 = v1 + v2</code>
            <span className="compare-note">and the chip decides where v3 lives</span>
          </div>
        </div>
      </>
    ),
  },
  {
    title: "What the AI actually writes",
    body: (
      <>
        <p>
          Every ANMA-1 instruction is exactly <strong>16 bytes</strong>: four numbers of four bytes each. Here is one, written in hexadecimal (base 16, two digits per byte):
        </p>
        <div className="record-demo" role="img" aria-label="The instruction 20 00 00 00, 03 00 00 00, 01 00 00 00, 02 00 00 00 means v3 = v1 + v2">
          {[
            ["20 00 00 00", "operation", "add"],
            ["03 00 00 00", "result", "v3"],
            ["01 00 00 00", "first input", "v1"],
            ["02 00 00 00", "second input", "v2"],
          ].map(([hex, role, meaning]) => (
            <span key={role} className="record-field">
              <code>{hex}</code>
              <span className="record-role">{role}</span>
              <span className="record-meaning">{meaning}</span>
            </span>
          ))}
          <span className="record-result">
            means <code>v3 = v1 + v2</code>
          </span>
        </div>
        <p>
          A whole program is simply a list of these. The platform game you can try on this site is about 250 of them, 4,080 bytes, every one written by the AI.
        </p>
      </>
    ),
  },
  {
    title: "How the AI writes a program: draft, check, fix",
    body: (
      <>
        <p>
          Writing hundreds of 16-byte instructions by hand, the AI makes mistakes, just as a person would. So it works in a loop with a <strong>checker</strong>: a program that reads the bytes, finds problems and explains them. The checker never runs the program and never writes or changes a byte. Fixing is always the AI's job.
        </p>
        <ol className="loop" aria-label="The generation loop">
          <li><strong>The AI drafts</strong> the whole program as bytes.</li>
          <li><strong>The checker reads it</strong> and explains every mistake: which rule broke, at which byte, what it found, and what was expected.</li>
          <li><strong>The AI fixes it</strong> and checks again, as many times as it needs.</li>
          <li><strong>It submits.</strong> Your browser then runs the tests on the simulated chip; any failures go back to the AI as more feedback.</li>
          <li className="loop-end">It stops when every check and test passes, or when it reaches its limits on time, attempts and cost.</li>
        </ol>
        <div className="diag-demo" aria-label="A real message from the checker">
          <span className="diag-demo-head">A real message the checker sent the AI while it wrote the platform game:</span>
          <code>record 5, byte 124: an unused field of JUMP must be zero, but it holds 68.</code>
          <code>Record 4 looks 4 bytes short: its last word is missing, so every later record is shifted.</code>
        </div>
      </>
    ),
  },
  {
    title: "Notes the AI attaches: claims, contracts, examples",
    body: (
      <>
        <p>
          Along with the bytes, the AI can send <strong>annotations</strong>: notes about what it meant to write. They sit beside the program, not inside it. The chip never reads them, but they let the site catch the difference between what the AI <em>meant</em> and what it actually <em>wrote</em>.
        </p>
        <ul className="notes">
          <li>
            <span className="note-kind">Claims</span>
            <span>
              What each instruction does, such as <code>record 3: v3 = v1 + v2</code>. The checker decodes the real bytes and flags any claim that doesn't match them.
            </span>
          </li>
          <li>
            <span className="note-kind">Contracts</span>
            <span>
              What the whole program promises, such as <code>result = n × n + 2</code>. The site checks the promise every time the program runs.
            </span>
          </li>
          <li>
            <span className="note-kind">Examples</span>
            <span>
              Inputs with the answers the AI expects, such as <code>n = 12 gives 146</code>. They are run on the chip, and a wrong answer goes back to the AI.
            </span>
          </li>
          <li>
            <span className="note-kind">Proofs</span>
            <span>In expert view, an automatic theorem prover (z3) can prove a contract holds for every possible input, not just the ones tested.</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    title: "Making AI better at writing ANMA-1",
    body: (
      <>
        <p>
          The AI used here is a general-purpose model. It learns ANMA-1 on the spot, from the manual we send with every request, so it is still learning the format as it goes. A model could be <strong>fine-tuned</strong> instead: trained further on many ANMA-1 programs until writing them becomes second nature.
        </p>
        <p>The loop on this site produces exactly the material that training needs, with no person writing it:</p>
        <ul className="notes">
          <li>
            <span className="note-kind">Examples</span>
            <span>Every program that passes the checker and its tests is a verified pair of “what was asked” and “the bytes that do it”.</span>
          </li>
          <li>
            <span className="note-kind">Lessons</span>
            <span>Every checker message together with the AI's fix shows a mistake and how to correct it.</span>
          </li>
          <li>
            <span className="note-kind">Scores</span>
            <span>
              The checker and tests grade each attempt automatically, so a model can practise and be rewarded for programs that are correct, and for programs that are <em>efficient</em> on the chip (fewer cycles, less shuffling of values to memory). This is reinforcement learning from rewards a computer can check.
            </span>
          </li>
        </ul>
        <Flow
          steps={[
            { label: "Requests", detail: "programs to write" },
            { label: "AI drafts", detail: "bytes" },
            { label: "Checker + tests", detail: "grade it", accent: true },
            { label: "Training", detail: "learn from passes", note: "then repeat" },
          ]}
        />
        <p className="intro-small">We haven't trained such a model yet; this is the natural next step.</p>
      </>
    ),
  },
  {
    title: "Is ANMA-1 a real chip?",
    body: (
      <>
        <p>
          Not yet. ANMA-1 exists as a precise specification. To run programs natively it would have to be <strong>manufactured</strong>: first as a prototype on an FPGA (a reprogrammable chip that hardware designers use to try out new processors), then as a custom chip made by a chip company.
        </p>
        <p>Until then, your browser stands in for the chip, in one of two ways:</p>
        <ul className="intro-list">
          <li>
            <strong>Exact</strong> simulates the chip step by step, and the chip diagram lights up to show which part is working.
          </li>
          <li>
            <strong>Fast</strong> translates the AI's binary into your own computer's machine code, the way Apple's Rosetta runs older Mac apps. Same results, much faster.
          </li>
        </ul>
        <p className="intro-small">Speeds shown for a real ANMA chip are estimates from a published cost model, and always labelled that way.</p>
      </>
    ),
  },
  {
    title: "See it for yourself",
    body: (
      <>
        <p>Watch a game the AI wrote run on the simulated chip, or ask the AI to write a program for you. You'll see every instruction it wrote, in plain English next to the raw bytes.</p>
      </>
    ),
  },
];

/** The step-by-step dialog both chapters use. */
function Tour({ open, onClose, steps, label, actions }: { open: boolean; onClose: () => void; steps: Step[]; label: string; actions: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setStep(0);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);
  const last = step === steps.length - 1;
  const s = steps[step]!;
  return (
    <dialog ref={ref} className="intro" aria-labelledby="intro-title" onClose={onClose} onCancel={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="intro-inner">
        <header className="intro-head">
          <span className="intro-kicker">{label} · {step + 1} of {steps.length}</span>
          <button className="intro-close" onClick={onClose} aria-label="Close the explanation">✕</button>
        </header>
        <h2 id="intro-title">{s.title}</h2>
        <div className="intro-body">{s.body}</div>
        {last && <div className="intro-actions">{actions}</div>}
        <footer className="intro-foot">
          <div className="intro-dots" role="tablist" aria-label="Steps">
            {steps.map((x, i) => (
              <button key={x.title} role="tab" aria-selected={i === step} aria-label={`Step ${i + 1}: ${x.title}`} className={i === step ? "on" : ""} onClick={() => setStep(i)} />
            ))}
          </div>
          <div className="intro-nav">
            {step > 0 && <button onClick={() => setStep(step - 1)}>Back</button>}
            {!last && <button className="primary" onClick={() => setStep(step + 1)} autoFocus>Next</button>}
          </div>
        </footer>
      </div>
    </dialog>
  );
}

export function Intro({ open, onClose, onAction, canGenerate }: { open: boolean; onClose: () => void; onAction: (a: IntroAction) => void; canGenerate: boolean }) {
  return (
    <Tour
      open={open}
      onClose={onClose}
      steps={STEPS}
      label="llmtobinary"
      actions={
        <>
          <button className="primary" onClick={() => onAction("watch")}>▶ Watch the AI's game run</button>
          <button onClick={() => onAction("ask")} disabled={!canGenerate} title={canGenerate ? "" : "Live generation is unavailable right now"}>✎ Ask the AI for a program</button>
          <button onClick={() => onAction("os")}>Next: from programs to an operating system →</button>
          <button className="link" onClick={() => onAction("explore")}>Look around on my own</button>
        </>
      }
    />
  );
}

const go = (href: string) => () => location.assign(href);

// Part two: the library, linking, trust levels and the OS. Same rules as part one: plain words,
// and every number here is one the site can show (docs/OS-STATUS.md, docs/os-evidence/).
const OS_STEPS: Step[] = [
  {
    title: "Every program goes into a public library",
    body: (
      <>
        <p>
          Every program anyone asks the AI for here is kept, working or not, in a public library called the <strong>Registry</strong>. You can browse it, run any program in it, and see exactly what was asked for.
        </p>
        <p>
          Each program is named by a <strong>fingerprint</strong> of its bytes (a hash). The same bytes always get the same fingerprint, and changing a single byte gives a completely different one. So a name always means exactly one program, and nobody can quietly swap it for another.
        </p>
        <Flow
          steps={[
            { label: "The program", detail: <code>20 00 00 00 03 …</code>, note: "the AI's bytes" },
            { label: "Fingerprint", detail: <code>sha256:fdcc63fe…</code>, note: "its permanent name", accent: true },
            { label: "Registry", detail: "public", note: "anyone can look it up" },
          ]}
        />
      </>
    ),
  },
  {
    title: "How much can you trust a program?",
    body: (
      <>
        <p>
          A program that runs isn't necessarily right. So every program carries a <strong>trust level</strong>, from E0 to E4. A level is earned only from checks that a computer ran and signed. Likes, stars and comments never change it.
        </p>
        <ul className="notes">
          <li><span className="note-kind">E0 Saved</span><span>The bytes exist. They might not even be a valid program.</span></li>
          <li><span className="note-kind">E1 Valid</span><span>The checker found no broken rules.</span></li>
          <li><span className="note-kind">E2 Consistent</span><span>It does what the AI's own notes say it does, but nobody else has tested it.</span></li>
          <li><span className="note-kind">E3 Tested</span><span>Our checking machine passed it, including on hidden tests the AI never saw.</span></li>
          <li><span className="note-kind">E4 Confirmed</span><span>A second machine, run by GitHub, repeated the tests and got exactly the same result, down to the last bit.</span></li>
        </ul>
        <p className="intro-small">A program you generate here starts at E1 or E2. It only goes higher if the checking machines test it.</p>
      </>
    ),
  },
  {
    title: "Programs can use other programs",
    body: (
      <>
        <p>
          Real software isn't written from scratch every time. If a program needs, say, the greatest common divisor of two numbers, it can use a <code>gcd</code> function that already exists rather than write its own.
        </p>
        <p>
          In ANMA-1 that is one instruction, <strong>CALL</strong>: go and run that function, then come back with its answer. A program can CALL a function that lives in a different program. A small tool called the <strong>linker</strong> then joins them into a single file and renumbers things so every CALL points to the right place.
        </p>
        <Flow
          steps={[
            { label: "Your program", detail: <code>CALL gcd</code> },
            { label: "+ math.gcd", detail: "from the library" },
            { label: "Linker", detail: "joins them into one file", accent: true },
            { label: "Checker", detail: "checks the whole file again" },
          ]}
        />
        <p className="intro-small">The linker never writes instructions; it only renumbers. The joined file is checked from scratch, so a mistake in the linker could produce a wrong program, but never one that breaks the chip's rules.</p>
      </>
    ),
  },
  {
    title: "An operating system, built the same way",
    body: (
      <>
        <p>
          An <strong>operating system</strong> is the program that runs other programs. It gives you a command line, keeps your files, and starts and stops programs. People normally spend years writing one in source code.
        </p>
        <p>
          Here it is split into small parts called <strong>slots</strong>, each with a written description of what it must do. The AI writes candidates for each slot as raw bytes, and a slot is filled by a candidate that passes its hidden tests. When several pass, a fixed rule picks one: most trusted, then smallest, then earliest. Never votes.
        </p>
        <ul className="notes">
          <li><span className="note-kind">kernel</span><span>the core that keeps everything running</span></li>
          <li><span className="note-kind">cmd</span><span>the commands you type, like <code>ls</code> and <code>run</code></span></li>
          <li><span className="note-kind">fs</span><span>files on the disk</span></li>
          <li><span className="note-kind">proc</span><span>starting programs and catching ones that crash</span></li>
          <li><span className="note-kind">str, line</span><span>handling text and reading what you type</span></li>
          <li><span className="note-kind">live</span><span>asking the AI for a new program from inside the OS</span></li>
        </ul>
        <Flow
          steps={[
            { label: "7 parts", detail: "each written by the AI" },
            { label: "Linker", detail: "joins them" },
            { label: "The OS", detail: "1,828 instructions", note: "29.5 KB, all AI-written", accent: true },
          ]}
        />
      </>
    ),
  },
  {
    title: "Boot it in your browser",
    body: (
      <>
        <p>
          Open <strong>Boot</strong> and your browser starts the OS on the simulated ANMA-1 chip. You get a terminal. Click it and type a command:
        </p>
        <ul className="notes">
          <li><span className="note-kind"><code>ls</code></span><span>list the files on the disk</span></li>
          <li><span className="note-kind"><code>run hello</code></span><span>start a program</span></li>
          <li><span className="note-kind"><code>run crash</code></span><span>start a program that breaks, and watch the OS catch it and carry on</span></li>
          <li><span className="note-kind"><code>write note hi</code></span><span>save a file; <code>cat note</code> reads it back. Your disk stays in your browser.</span></li>
          <li><span className="note-kind"><code>gen</code></span><span>ask the AI for a new program, such as <code>gen sum print the sum of 1 to 100</code>. The page shows you the request first, and the new program runs inside the OS without restarting it.</span></li>
        </ul>
      </>
    ),
  },
  {
    title: "The AI now reuses the library by itself",
    body: (
      <>
        <p>
          When you ask for a program, the AI now also gets a short index of every library function at the top trust level, E4. It decides for itself whether to use one, can search for more, or writes everything itself. Nobody chooses for it.
        </p>
        <p>
          The site then joins in the pieces it chose, as in step 3, so you still get one ordinary file. The program's page lists what it was <strong>built from</strong>, and each library piece shows how many programs reuse it.
        </p>
        <Flow
          steps={[
            { label: "Your request", detail: <q>print a checksum</q> },
            { label: "AI", detail: "picks crc-8 from the library", accent: true },
            { label: "Linker", detail: "joins it in" },
            { label: "One program", detail: "built from crc-8" },
          ]}
        />
        <p className="intro-small">
          Before switching this on we ran a test of 60 sessions, with the rules for passing written down in advance. On the two tasks where reuse made sense, a hash and a checksum, the AI reused a library piece every time and wrote 36% and 63% less. On simpler tasks it wrote everything itself. Overall it only just cleared the bar we had set.
        </p>
      </>
    ),
  },
  {
    title: "What this is, and what it isn't",
    body: (
      <>
        <ul className="intro-list">
          <li>The AI wrote every instruction of the OS and its programs, as bytes. People and agents designed the slots, their descriptions and the tests.</li>
          <li>It is a very small OS: a few commands, up to 16 files in one folder, and programs that take turns rather than run at the same time. Nothing stops one program from touching another's files.</li>
          <li>It runs on the simulated ANMA-1 chip in your browser, not on real hardware.</li>
        </ul>
        <p>Try it, or look at the parts it is made of.</p>
      </>
    ),
  },
];

export function OsIntro({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Tour
      open={open}
      onClose={onClose}
      steps={OS_STEPS}
      label="Part 2: the library and the OS"
      actions={
        <>
          <button className="primary" onClick={go("/boot")}>▶ Boot the OS</button>
          <button onClick={go("/registry")}>Browse the library</button>
          <button onClick={go("/os")}>See the OS parts</button>
        </>
      }
    />
  );
}
