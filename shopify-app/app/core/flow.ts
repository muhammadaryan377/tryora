// GENERATED from packages/core/src by scripts/sync-core.mjs. Do not edit here.
/**
 * Shopper popup flow, as a pure reducer. The storefront UI renders whatever `step` says and sends events.
 * Approved flow (owner decisions, 18 Oct 2026):
 *   opening -> photoReady -> [emailStep, first generation only] -> generating -> result
 *   result: "Try another colour"  -> photoReady (same photo kept)
 *           "Use a different room" -> photoReady (photo cleared)
 *   Colours already generated for this room are marked "viewed" and reopen instantly at no charge.
 * Image bytes live only in browser memory, referenced here by opaque handles.
 */

import type { PhotoProblem } from "./provider.js";

export type Step =
  | "opening" // product reference, colour choice, photo guidance, take/upload
  | "photoReady" // photo selected; checking or checked; pick colour; Generate image
  | "emailStep" // lead capture before the first generation in a session
  | "generating" // real progress stages from the job
  | "result" // generated image + Try another colour / Download / Use a different room / Report + voucher
  | "unavailable"; // previews paused or the app is unavailable

export type PhotoCheck =
  | { status: "checking" }
  | { status: "ok"; detected?: "existing_item" | "empty_space" | "wall" | "floor_area" }
  | { status: "needsCorrection"; reason: PhotoProblem }
  | { status: "fileRejected"; reason: "unsupported_format" | "too_large" | "too_small" | "unreadable" };

export type GenerationStage = "waiting" | "uploading" | "checking_photo" | "preparing" | "generating" | "checking_result";

export interface GeneratedResult {
  option: string;
  roomPhotoId: string;
  /** Browser object URL or in-memory handle for the generated image. Never persisted. */
  imageHandle: string;
  jobId: string;
}

export interface FlowState {
  step: Step;
  selectedOption: string | null;
  photo: { id: string; check: PhotoCheck } | null;
  leadMode: "off" | "required" | "skippable";
  leadDone: boolean;
  /** Results generated for the current room photo in this live session, keyed by option. */
  results: Record<string, GeneratedResult>;
  /** Option whose result is on screen. */
  shownOption: string | null;
  generation: { option: string; stage: GenerationStage; jobId?: string } | null;
  /** Shopper-facing problem to show, if any. Copy is chosen by the UI from this code. */
  notice:
    | null
    | "generation_failed"
    | "result_rejected"
    | "quota_reached"
    | "previews_paused"
    | "connection_lost"
    | "taking_longer";
}

export type FlowEvent =
  | { type: "SELECT_OPTION"; option: string }
  | { type: "PHOTO_SELECTED"; photoId: string }
  | { type: "PHOTO_CHECKED"; check: Exclude<PhotoCheck, { status: "checking" }> }
  | { type: "REMOVE_PHOTO" }
  | { type: "GENERATE_PRESSED" }
  | { type: "LEAD_SUBMITTED" }
  | { type: "LEAD_SKIPPED" }
  | { type: "JOB_STARTED"; jobId: string }
  | { type: "JOB_STAGE"; stage: GenerationStage }
  | { type: "JOB_SLOW" }
  | { type: "JOB_DELIVERED"; result: Omit<GeneratedResult, "roomPhotoId"> }
  | { type: "JOB_FAILED"; reason: "generation_failed" | "result_rejected" | "quota_reached" | "previews_paused" }
  | { type: "TRY_ANOTHER_COLOUR" }
  | { type: "USE_DIFFERENT_ROOM" }
  | { type: "SHOW_RESULT"; option: string }
  | { type: "PREVIEWS_UNAVAILABLE" };

/** Side effects the UI must perform after a transition. The reducer itself stays pure. */
export type FlowCommand =
  | { type: "START_PHOTO_CHECK"; photoId: string }
  | { type: "CREATE_PREVIEW"; option: string; photoId: string }
  | { type: "RELEASE_IMAGES"; photoId: string } // revoke object URLs for this room's images
  | { type: "SUBMIT_LEAD" };

export function initialFlow(options: { leadMode: FlowState["leadMode"]; defaultOption: string | null }): FlowState {
  return {
    step: "opening",
    selectedOption: options.defaultOption,
    photo: null,
    leadMode: options.leadMode,
    leadDone: options.leadMode === "off",
    results: {},
    shownOption: null,
    generation: null,
    notice: null,
  };
}

export function isViewed(state: FlowState, option: string): boolean {
  return !!state.results[option];
}

export function canGenerate(state: FlowState): boolean {
  return (
    !!state.photo &&
    state.photo.check.status === "ok" &&
    !!state.selectedOption &&
    state.generation === null
  );
}

/** Photo-check note for step 2. Returns null when nothing should be shown (including when the check is unsure). */
export function photoNote(check: PhotoCheck | undefined, itemNoun: string): string | null {
  if (!check || check.status !== "ok" || !check.detected) return null;
  switch (check.detected) {
    case "existing_item": return `Existing ${itemNoun} detected – we'll replace it`;
    case "empty_space": return "Empty space – we'll place it here";
    case "wall": return "Wall detected";
    case "floor_area": return "Floor area detected";
  }
}

/** Shopper-facing message for a photo that can't be used. The shopper keeps the popup and can try another photo. */
export function photoProblemMessage(reason: PhotoProblem, itemNoun: string, setting: "indoor" | "outdoor" | "either" = "indoor"): string {
  switch (reason) {
    case "not_a_room":
      return setting === "outdoor"
        ? `This doesn't look like an outdoor space. Try a photo of the patio, deck or garden where the ${itemNoun} will go.`
        : `This doesn't look like a room. Try a photo of the space where the ${itemNoun} will go.`;
    case "wrong_setting":
      return setting === "outdoor"
        ? `This ${itemNoun} is made for outdoor spaces. Try a photo of your garden, patio or terrace.`
        : `This ${itemNoun} is made for indoor spaces. Try a photo taken inside your home.`;
    case "no_suitable_surface":
      return `We can't see where the ${itemNoun} would go. Make sure the wall or floor area is clearly in the photo.`;
    case "wrong_angle":
      return "Try taking the photo straight on, at roughly the same angle as the product photo.";
    case "dark_or_blurred":
      return "This photo is a little dark or blurry. Try again in better light and hold your phone steady.";
    case "area_cut_off":
      return `Part of the space is cut off. Step back so the whole area for the ${itemNoun} is in the photo.`;
    case "unclear_target":
      return `We're not sure where the ${itemNoun} should go. Try a photo with the space more clearly in view.`;
    case "not_allowed":
      return "We can't use this photo. Please upload a photo of your room without people as the main subject.";
  }
}

export interface Transition {
  state: FlowState;
  commands: FlowCommand[];
}

export function reduce(state: FlowState, event: FlowEvent): Transition {
  const none = (s: FlowState): Transition => ({ state: s, commands: [] });

  switch (event.type) {
    case "SELECT_OPTION": {
      // Option changes are locked while a job runs; the selection stays visible.
      if (state.generation) return none(state);
      return none({ ...state, selectedOption: event.option, notice: null });
    }

    case "PHOTO_SELECTED": {
      const commands: FlowCommand[] = [{ type: "START_PHOTO_CHECK", photoId: event.photoId }];
      if (state.photo) commands.push({ type: "RELEASE_IMAGES", photoId: state.photo.id });
      return {
        state: {
          ...state,
          step: "photoReady",
          photo: { id: event.photoId, check: { status: "checking" } },
          results: {}, // previews of a different room do not carry over
          shownOption: null,
          notice: null,
        },
        commands,
      };
    }

    case "PHOTO_CHECKED": {
      if (!state.photo) return none(state);
      return none({ ...state, photo: { ...state.photo, check: event.check } });
    }

    case "REMOVE_PHOTO": {
      if (state.generation) return none(state);
      const commands: FlowCommand[] = state.photo ? [{ type: "RELEASE_IMAGES", photoId: state.photo.id }] : [];
      return { state: { ...state, step: "opening", photo: null, results: {}, shownOption: null }, commands };
    }

    case "GENERATE_PRESSED": {
      if (!canGenerate(state)) return none(state);
      const option = state.selectedOption!;
      // Already generated for this room: reopen instantly, no new job, no charge.
      if (state.results[option]) {
        return none({ ...state, step: "result", shownOption: option, notice: null });
      }
      if (!state.leadDone) return none({ ...state, step: "emailStep", notice: null });
      return startGeneration(state, option);
    }

    case "LEAD_SUBMITTED": {
      if (state.step !== "emailStep") return none(state);
      const next = startGeneration({ ...state, leadDone: true }, state.selectedOption!);
      return { state: next.state, commands: [{ type: "SUBMIT_LEAD" }, ...next.commands] };
    }

    case "LEAD_SKIPPED": {
      if (state.step !== "emailStep" || state.leadMode !== "skippable") return none(state);
      return startGeneration({ ...state, leadDone: true }, state.selectedOption!);
    }

    case "JOB_STARTED": {
      if (!state.generation) return none(state);
      return none({ ...state, generation: { ...state.generation, jobId: event.jobId } });
    }

    case "JOB_STAGE": {
      if (!state.generation) return none(state);
      return none({ ...state, generation: { ...state.generation, stage: event.stage } });
    }

    case "JOB_SLOW":
      return state.generation ? none({ ...state, notice: "taking_longer" }) : none(state);

    case "JOB_DELIVERED": {
      // Ignore a late result for a room the shopper has since replaced.
      if (!state.generation || !state.photo) return none(state);
      const result: GeneratedResult = { ...event.result, roomPhotoId: state.photo.id };
      return none({
        ...state,
        step: "result",
        results: { ...state.results, [result.option]: result },
        shownOption: result.option,
        generation: null,
        notice: null,
      });
    }

    case "JOB_FAILED": {
      // A failed later attempt never removes an earlier successful result.
      const fallback = state.shownOption && state.results[state.shownOption] ? "result" : "photoReady";
      if (event.reason === "previews_paused") {
        return none({ ...state, generation: null, step: fallback === "result" ? "result" : "unavailable", notice: "previews_paused" });
      }
      return none({ ...state, generation: null, step: fallback, notice: event.reason });
    }

    case "TRY_ANOTHER_COLOUR":
      if (state.step !== "result") return none(state);
      return none({ ...state, step: "photoReady", notice: null });

    case "USE_DIFFERENT_ROOM": {
      if (state.step !== "result" || !state.photo) return none(state);
      return {
        state: { ...state, step: "photoReady", photo: null, results: {}, shownOption: null, notice: null },
        commands: [{ type: "RELEASE_IMAGES", photoId: state.photo.id }],
      };
    }

    case "SHOW_RESULT":
      if (!state.results[event.option]) return none(state);
      return none({ ...state, step: "result", shownOption: event.option, selectedOption: event.option });

    case "PREVIEWS_UNAVAILABLE":
      return none({ ...state, step: state.shownOption ? state.step : "unavailable", notice: "previews_paused" });
  }
}

function startGeneration(state: FlowState, option: string): Transition {
  return {
    state: { ...state, step: "generating", generation: { option, stage: "waiting" }, notice: null },
    commands: [{ type: "CREATE_PREVIEW", option, photoId: state.photo!.id }],
  };
}
