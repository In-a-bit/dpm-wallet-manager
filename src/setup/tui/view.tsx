import { PasswordInput, TextInput } from "@inkjs/ui";
import { Box, Text, useAnimation } from "ink";
import type { ReactNode } from "react";

import type { JourneyItem } from "../catalog";
import { formatDuration, type Journey, type JourneyRow, type RowStatus } from "../journey";

/**
 * How the dashboard looks, and nothing about how it behaves: every component here renders its
 * props, so each state of the screen can be rendered on its own (see test/tui).
 */

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const COLOR: Record<RowStatus, string> = {
  done: "green",
  running: "cyan",
  asking: "yellow",
  failed: "red",
  pending: "gray",
  skipped: "gray",
};

const ICON: Record<Exclude<RowStatus, "running">, string> = {
  done: "✔",
  asking: "◆",
  failed: "✖",
  pending: "○",
  skipped: "–",
};

const TITLE_WIDTH = 32;
const TIME_WIDTH = 8;

export type FrameProps = {
  journey: Journey;
  /** The row the panel explains; highlighted in the list. */
  selectedId?: string;
  elapsedMs: number;
  width: number;
  /** The key hints under the box. */
  keys: string;
  /** Spinner frame; the app animates it, a test fixes it. */
  frame: number;
  children: ReactNode;
};

export function Frame({
  journey,
  selectedId,
  elapsedMs,
  width,
  keys,
  frame,
  children,
}: FrameProps) {
  const inner = width - 4;
  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text>
            <Text color="cyan" bold>
              ◆ DPM Custody
            </Text>
            <Text dimColor> · setup</Text>
          </Text>
          <Text dimColor>
            {journey.complete ? "complete" : `step ${journey.position} of ${journey.total}`}
            {" · "}
            {formatDuration(elapsedMs)}
          </Text>
        </Box>
        <Progress journey={journey} width={inner} />
        <Box flexDirection="column" marginTop={1}>
          {journey.rows.map((row) => (
            <Row key={row.id} row={row} selected={row.id === selectedId} frame={frame} />
          ))}
        </Box>
        <Text color="gray">{"─".repeat(inner)}</Text>
        <Box flexDirection="column" minHeight={5}>
          {children}
        </Box>
      </Box>
      <Box paddingX={2}>
        <Text dimColor>{keys}</Text>
      </Box>
    </Box>
  );
}

function Progress({ journey, width }: { journey: Journey; width: number }) {
  const done = journey.rows.filter((row) => row.status === "done").length;
  const filled = Math.round((done / Math.max(journey.total, 1)) * width);
  return (
    <Text>
      <Text color="green">{"━".repeat(filled)}</Text>
      <Text color="gray">{"━".repeat(Math.max(width - filled, 0))}</Text>
    </Text>
  );
}

function Row({ row, selected, frame }: { row: JourneyRow; selected: boolean; frame: number }) {
  const icon =
    row.status === "running" ? (SPINNER[frame % SPINNER.length] as string) : ICON[row.status];
  const dim = row.status === "pending" || row.status === "skipped";
  const result =
    row.status === "skipped"
      ? "not needed in this mode"
      : row.status === "asking"
        ? "waiting for you"
        : row.result;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={selected ? "cyan" : undefined}>{selected ? "›" : " "}</Text>
        <Box width={2}>
          <Text color={COLOR[row.status]}>{icon}</Text>
        </Box>
        <Box width={TITLE_WIDTH}>
          <Text
            wrap="truncate-end"
            bold={selected || row.status === "running" || row.status === "asking"}
            dimColor={dim && !selected}
            strikethrough={row.status === "skipped"}
          >
            {row.title}
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text wrap="truncate-end" color={row.status === "asking" ? "yellow" : "gray"}>
            {result ?? ""}
          </Text>
        </Box>
        <Box width={TIME_WIDTH} justifyContent="flex-end">
          <Text dimColor>{row.ms !== undefined ? formatDuration(row.ms) : ""}</Text>
        </Box>
      </Box>
      {row.status === "running" && row.live ? (
        <Box paddingLeft={4}>
          <Text color="cyan" wrap="truncate-end">
            └ {row.live}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** A question: what it is for, the input, and the outcome of the last check. */
export type Notice = { kind: "busy" | "error" | "ok"; text: string };

export function QuestionPanel({
  item,
  hint,
  notice,
  frame,
  children,
}: {
  item: JourneyItem;
  hint?: string;
  notice?: Notice;
  frame: number;
  children: ReactNode;
}) {
  return (
    <Box flexDirection="column">
      <Text color="yellow" bold>
        {item.title}
      </Text>
      <Text>{item.short}</Text>
      {hint ? <Text dimColor>{hint}</Text> : null}
      <Box marginTop={1}>{children}</Box>
      {notice ? <NoticeLine notice={notice} frame={frame} /> : null}
    </Box>
  );
}

function NoticeLine({ notice, frame }: { notice: Notice; frame: number }) {
  if (notice.kind === "busy") {
    return (
      <Text color="cyan">
        {SPINNER[frame % SPINNER.length]} {notice.text}
      </Text>
    );
  }
  return (
    <Text color={notice.kind === "error" ? "red" : "green"}>
      {notice.kind === "error" ? "✖" : "✔"} {notice.text}
    </Text>
  );
}

export type Depth = "short" | "long" | "details";

/** The selected step, explained as deeply as asked for. */
export function StepPanel({
  row,
  depth,
  details,
}: {
  row: JourneyRow;
  depth: Depth;
  details: string[];
}) {
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{row.title}</Text>
        <Text color={COLOR[row.status]}> · {statusWords(row)}</Text>
      </Text>
      {depth === "details" ? (
        details.length ? (
          details.map((line, i) => (
            <Text key={i} dimColor wrap="truncate-end">
              {line}
            </Text>
          ))
        ) : (
          <Text dimColor>Nothing recorded for this step yet.</Text>
        )
      ) : (
        <>
          <Text>{row.short}</Text>
          {depth === "long" ? (
            <Box marginTop={1}>
              <Text dimColor>{row.long}</Text>
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
}

function statusWords(row: JourneyRow): string {
  switch (row.status) {
    case "done":
      return row.ms !== undefined ? `done in ${formatDuration(row.ms)}` : "done";
    case "running":
      return "in progress";
    case "asking":
      return "waiting for your answer";
    case "failed":
      return "stopped";
    case "pending":
      return "still to come";
    case "skipped":
      return "not needed in this mode";
  }
}

/** Where setup stopped, what to try, and what to give support. */
export function FailurePanel({ row, reference }: { row: JourneyRow; reference: string }) {
  return (
    <Box flexDirection="column">
      <Text color="red" bold>
        ✖ Setup stopped at “{row.title}”
      </Text>
      <Text>{row.error}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>What to try: </Text>
          {row.fix} Then press <Text color="cyan">r</Text> to try again.
        </Text>
        <Text>
          <Text bold>Need help? </Text>Run <Text color="cyan">./dpm-custody support</Text> and send
          the file it writes to the platform team.
        </Text>
        <Text dimColor>Reference: {reference}</Text>
      </Box>
    </Box>
  );
}

/** The end: what to hand the backend, where the dashboard is, where help is. */
export function DonePanel({ lines }: { lines: [string, string][] }) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        ✔ Your custody install is ready
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {lines.map(([label, value]) => (
          <Box key={label}>
            <Box width={24}>
              <Text dimColor>{label}</Text>
            </Box>
            <Text>{value}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Everyday commands: ./dpm-custody (start, stop, status, backup). Help: ./dpm-custody
          support
        </Text>
      </Box>
    </Box>
  );
}

/**
 * The backup kit as plain text, written once above the dashboard so it stays in the terminal.
 * Not drawn by Ink: a box would wrap the long keys across lines and break them when copied.
 */
export function kitText(kit: string): string {
  const rule = "═".repeat(72);
  return [
    "",
    `\u001b[33m${rule}\u001b[0m`,
    "\u001b[1;33m BACKUP KIT · copy everything between the two lines somewhere safe\u001b[0m",
    `\u001b[33m${rule}\u001b[0m`,
    "",
    kit.trimEnd(),
    "",
    `\u001b[33m${rule}\u001b[0m`,
    "",
  ].join("\n");
}

/** The spinner frame, ticking only while something on screen moves. */
export function useSpinnerFrame(active: boolean): number {
  return useAnimation({ interval: 80, isActive: active }).frame;
}

/**
 * A one-line answer. A paste that ends in a line break arrives in one piece with it, and the
 * underlying input would keep the break as text; here a break submits what came before it.
 */
export function LineInput({
  hidden,
  placeholder,
  isDisabled,
  onSubmit,
}: {
  hidden?: boolean;
  placeholder?: string;
  isDisabled?: boolean;
  onSubmit: (value: string) => void;
}) {
  const onChange = (value: string) => {
    const brk = value.search(/[\r\n]/);
    if (brk !== -1) onSubmit(value.slice(0, brk));
  };
  const Input = hidden ? PasswordInput : TextInput;
  return (
    <Box>
      <Text color="cyan">› </Text>
      <Input
        placeholder={placeholder}
        isDisabled={isDisabled}
        onChange={onChange}
        onSubmit={onSubmit}
      />
    </Box>
  );
}
