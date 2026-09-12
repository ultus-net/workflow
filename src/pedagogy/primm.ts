export const PRIMM_STAGES = [
  "predict",
  "run",
  "investigate",
  "modify",
  "make",
] as const;

export type PrimmStage = typeof PRIMM_STAGES[number];

export interface PrimmScaffoldInput {
  readonly snippet: string;
  readonly goal: string;
  readonly concept: string;
}

export interface PrimmPrompt {
  readonly stage: PrimmStage;
  readonly title: string;
  readonly prompt: string;
}

export function primmScaffold(input: PrimmScaffoldInput): readonly PrimmPrompt[] {
  const { snippet, goal, concept } = input;
  return [
    {
      stage: "predict",
      title: "Predict",
      prompt:
        `Read this snippet whose goal is to ${goal}:\n\n${snippet}\n\n` +
        `Predict what it will do when it runs. Write down your prediction before running anything.`,
    },
    {
      stage: "run",
      title: "Run",
      prompt:
        `Run the snippet and observe the actual output:\n\n${snippet}\n\n` +
        `Did it match your prediction? If not, note exactly where your mental model diverged.`,
    },
    {
      stage: "investigate",
      title: "Investigate",
      prompt:
        `Investigate how the snippet uses ${concept}:\n\n${snippet}\n\n` +
        `Trace it line by line. For each line, explain what changes and why it is needed to ${goal}.`,
    },
    {
      stage: "modify",
      title: "Modify",
      prompt:
        `Modify the snippet so it still ${goal}s but behaves differently in one visible way ` +
        `(for example, change the data, the output format, or a step involving ${concept}):\n\n${snippet}`,
    },
    {
      stage: "make",
      title: "Make",
      prompt:
        `Make something of your own that uses ${concept} to solve a new problem similar to "${goal}". ` +
        `Write the snippet from scratch, then predict and run it again.`,
    },
  ];
}

export interface FillInGapBlank {
  readonly placeholder: string;
  readonly answer: string;
}

export interface FillInGapTemplate {
  readonly masked: string;
  readonly blanks: readonly FillInGapBlank[];
}

export function fillInTheGap(input: {
  readonly snippet: string;
  readonly targets: readonly string[];
}): FillInGapTemplate {
  const { snippet, targets } = input;
  for (const target of targets) {
    if (target.trim().length === 0) throw new TypeError("fill-in-the-gap targets must not be empty");
    if (!snippet.includes(target)) {
      throw new TypeError(`fill-in-the-gap target not found in snippet: ${JSON.stringify(target)}`);
    }
  }

  // Single left-to-right scan; longest matching target wins at each position.
  const ordered = [...targets].sort((a, b) => b.length - a.length);
  const blanks: FillInGapBlank[] = [];
  let masked = "";
  let cursor = 0;
  while (cursor < snippet.length) {
    const target = ordered.find((candidate) => snippet.startsWith(candidate, cursor));
    if (target === undefined) {
      masked += snippet[cursor];
      cursor += 1;
      continue;
    }
    const placeholder = `___${blanks.length + 1}___`;
    blanks.push({ placeholder, answer: target });
    masked += placeholder;
    cursor += target.length;
  }

  return { masked, blanks };
}
