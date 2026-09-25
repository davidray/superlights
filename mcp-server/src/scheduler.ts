import { evaluateSchedule, timeInRange, loadConfig, type ActiveRule } from "./holidaySchedule.js";
import { playSceneLive, stopStream, isStreaming } from "./liveStreamController.js";
import * as actions from "./actions.js";
import { sceneLabel, type SceneRef } from "./sceneSpec.js";

// Runs inside the always-on trigger server. Every tick: figure out which rule (if
// any) applies today for each device -- overrides beat holiday windows beat the
// device's default schedule, evaluated per device so devices schedule independently
// (the house and a lamp can both be on at once) -- and whether each should currently
// be on or off per its onTime/offTime, then fire a transition where that differs
// from what we last applied. Scenes always refer to custom scenes (scenes.ts),
// streamed live via DDP, not WLED presets/effects -- this scheduler is scoped to
// that one job. A rule's scene is either a registered scene id or an inline scene
// spec (palette + pattern), so a one-off look never needs a scenes.ts entry.
//
// Between transitions the scheduler also re-asserts the state it last applied: a
// device that rebooted (and came up lit by WLED's own power-on default), was switched
// on from the WLED app, or lost its stream is nudged back to what the rule says.
// Only a genuine disagreement triggers a command, so a device that already matches
// is never re-sent anything.

const TICK_MS = 30_000;

interface AppliedState {
  ruleId: string;
  on: boolean;
}

/** The side effects a tick needs, injectable so the reconcile logic is unit-testable
 *  without a schedule file, a device, or a DDP socket. */
export interface SchedulerIo {
  rulesFor(now: Date): ActiveRule[];
  applyOn(device: string, scene: SceneRef): Promise<void>;
  applyOff(device: string): Promise<void>;
  /** Actual power state of the device right now. Rejects if the device is unreachable. */
  isPoweredOn(device: string): Promise<boolean>;
  /** Whether this process currently has a live stream running for the device. */
  isStreaming(device: string): boolean;
  log(message: string): void;
}

const realIo: SchedulerIo = {
  rulesFor: (now) => evaluateSchedule(now, loadConfig()),
  applyOn: async (device, scene) => {
    // WLED scales realtime (DDP) data by its own brightness, so a device that is
    // powered off shows nothing even while a stream is running. Make sure it is on
    // first -- this is also what lets the drift check treat "powered off" as drift.
    await actions.setPower(device, true);
    await playSceneLive(device, scene, {});
  },
  applyOff: async (device) => {
    stopStream(device);
    await actions.setPower(device, false);
  },
  isPoweredOn: (device) => actions.getPower(device),
  isStreaming,
  log: (message) => console.error(`[scheduler] ${message}`),
};

/** Decide whether a device that already had `shouldBeOn` applied has drifted away
 *  from it and needs the transition re-sent. Pure, so the cases are easy to test. */
export function hasDrifted(shouldBeOn: boolean, poweredOn: boolean, streaming: boolean): boolean {
  if (shouldBeOn) return !poweredOn || !streaming;
  return poweredOn;
}

/** One pass over every scheduled device. Exported for tests; `startScheduler` runs it
 *  on an interval against the real devices. */
export async function reconcile(now: Date, io: SchedulerIo, lastApplied: Map<string, AppliedState>): Promise<void> {
  const rules = io.rulesFor(now);
  const ruleByDevice = new Map(rules.map((r) => [r.device, r]));

  // A device we previously touched whose rule disappeared entirely (deleted/disabled
  // mid-day) gets turned off -- once -- then forgotten.
  for (const [device, state] of lastApplied) {
    if (ruleByDevice.has(device)) continue;
    if (state.on) {
      await io.applyOff(device).catch((err) => io.log(`failed to power off ${device}: ${(err as Error).message}`));
    }
    lastApplied.delete(device);
  }

  // One device failing (unplugged lamp, WLED mid-reboot) must not block the others,
  // or leave stale lastApplied state that suppresses a retry: only record the new
  // state once the transition actually succeeded.
  for (const [device, rule] of ruleByDevice) {
    const shouldBeOn = timeInRange(now, rule.onTime, rule.offTime);
    const prev = lastApplied.get(device);

    if (prev?.ruleId === rule.id && prev.on === shouldBeOn) {
      // Already applied: verify the device still agrees. An unreachable device is
      // left alone -- it will be checked again next tick.
      let poweredOn: boolean;
      try {
        poweredOn = await io.isPoweredOn(device);
      } catch (err) {
        io.log(`could not read ${device} state: ${(err as Error).message}`);
        continue;
      }
      if (!hasDrifted(shouldBeOn, poweredOn, io.isStreaming(device))) continue;
      io.log(`${device} drifted from "${rule.name}" (expected ${shouldBeOn ? "on" : "off"}, found ${poweredOn ? "on" : "off"}${shouldBeOn && !io.isStreaming(device) ? ", no stream" : ""}) -> re-applying`);
    }

    try {
      if (shouldBeOn) {
        io.log(`applying "${rule.name}" (${rule.source}) -> scene "${sceneLabel(rule.scene)}" on ${device}`);
        await io.applyOn(device, rule.scene);
      } else {
        io.log(`"${rule.name}" (${rule.source}) off period -> powering off ${device}`);
        await io.applyOff(device);
      }
      lastApplied.set(device, { ruleId: rule.id, on: shouldBeOn });
    } catch (err) {
      io.log(`transition failed for ${device}: ${(err as Error).message}`);
    }
  }
}

export function startScheduler(): void {
  const lastApplied = new Map<string, AppliedState>();
  const run = () => reconcile(new Date(), realIo, lastApplied).catch((err) => realIo.log(`tick failed: ${(err as Error).message}`));
  void run();
  setInterval(() => void run(), TICK_MS);
}
