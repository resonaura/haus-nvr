import { createHash, randomUUID } from "node:crypto";
import { CameraContinuity } from "./camera-continuity.mjs";

const owner = (id) =>
  `activity-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const same = (a, b) =>
  JSON.stringify({ ...a, expiresAt: 0 }) ===
  JSON.stringify({ ...b, expiresAt: 0 });

/** Only explicit controller assignments enable analysis. Reuses the admitted RTSP producer. */
export class CameraActivity extends CameraContinuity {
  constructor(path, key, cameras, detectors, options = {}) {
    super(path, key, cameras, options);
    this.detectors = detectors;
    this.jobs = new Map();
    this.detections = new Map();
  }
  async initialize() {
    await super.initialize();
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick().catch(() => {}), 1000);
    this.timer.unref();
    return this;
  }
  async validate(values, restoring = false) {
    const plans = await super.validate(values, restoring);
    for (const value of values) {
      const plan = plans.get(value.cameraId);
      if (!plan) continue;
      if (
        !uuid(value.policyId) ||
        !["objects", "motion"].includes(value.mode) ||
        !Number.isInteger(value.postRollSeconds) ||
        value.postRollSeconds < 5 ||
        value.postRollSeconds > 120 ||
        !Number.isInteger(value.maxEventSeconds) ||
        value.maxEventSeconds < 30 ||
        value.maxEventSeconds > 300
      )
        throw Error("invalid_camera_activity");
      Object.assign(plan, {
        policyId: value.policyId,
        mode: value.mode,
        postRollSeconds: value.postRollSeconds,
        maxEventSeconds: value.maxEventSeconds,
      });
    }
    return plans;
  }
  async release(id) {
    const job = this.jobs.get(id);
    this.jobs.delete(id);
    if (job) await this.detectors.remove(job.detectorId);
    for (const session of [...this.cameras.sessions.values()])
      if (session.cameraId === id && session.owners.has(owner(id)))
        await this.cameras.release(session.id, owner(id)).catch(() => {});
  }
  status() {
    return {
      profile: 1,
      cameras: [...this.plans.values()]
        .filter((plan) => plan.expiresAt > this.now())
        .map((plan) => {
          const job = this.jobs.get(plan.cameraId),
            detector = this.detectors.jobs.get(job?.detectorId),
            worker = detector?.worker;
          return {
            cameraId: plan.cameraId,
            policyId: plan.policyId,
            generation: job?.detectorId,
            mode: plan.mode,
            expiresAt: plan.expiresAt,
            state: worker?.state ?? "waiting",
            calibrated: worker?.calibrated === true,
            lastResultAt: worker?.lastResult,
            events: (detector?.events ?? [])
              .filter((event) => event.sequence <= (job?.sequence ?? 0))
              .map((event) => ({ ...event, recordingManaged: true })),
          };
        }),
    };
  }
  detect(id, event, native = false) {
    const task = (this.detections.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.recordDetection(id, event, native));
    this.detections.set(id, task);
    return task.finally(() => {
      if (this.detections.get(id) === task) this.detections.delete(id);
    });
  }
  async trigger(input) {
    const plan = this.plans.get(input?.cameraId);
    if (
      !plan ||
      plan.expiresAt <= this.now() ||
      input.policyId !== plan.policyId ||
      !uuid(input.requestId)
    )
      throw Error("invalid_camera_activity");
    const job = this.jobs.get(input.cameraId);
    if (!job) throw Error("camera_activity_waiting");
    job.requests ??= new Map();
    if (job.requests.has(input.requestId))
      return job.requests.get(input.requestId);
    const event = { kind: input.kind, at: input.at };
    await this.detect(input.cameraId, event, true);
    if (!event.recordedEventId) throw Error("camera_activity_waiting");
    const result = { recordedEventId: event.recordedEventId };
    job.requests.set(input.requestId, result);
    if (job.requests.size > 128)
      job.requests.delete(job.requests.keys().next().value);
    return result;
  }
  async recordDetection(id, event, native) {
    if (this.stopped) return;
    const plan = this.plans.get(id),
      job = this.jobs.get(id);
    if (
      !plan ||
      !job ||
      plan.expiresAt <= this.now() ||
      !same(job.plan, plan) ||
      !(
        native
          ? ["motion", "person", "pet", "vehicle", "doorbell"]
          : ["motion", "person", "pet", "vehicle"]
      ).includes(event.kind) ||
      !Number.isSafeInteger(event.at) ||
      Math.abs(this.now() - event.at) > 30000
    )
      return;
    if (this.now() - (job.delivered?.get(event.kind) ?? -Infinity) < 3000) {
      if (job.capture) event.recordedEventId = job.capture.id;
      return;
    }
    job.delivered ??= new Map();
    job.delivered.set(event.kind, this.now());
    const session = this.cameras.sessions.get(job.sessionId);
    if (!session?.ring.ready()) return;
    let capture = job.capture;
    if (
      !capture ||
      event.at - capture.startAt >= plan.maxEventSeconds * 1000 ||
      capture.endAt - Math.min(capture.startAt, event.at) >
        plan.maxEventSeconds * 1000 ||
      capture.endAt + 1000 < event.at ||
      session.ring.jobs.get(capture.id)?.state !== "recording"
    ) {
      capture = {
        id: randomUUID(),
        cameraId: id,
        startAt: event.at,
        endAt: event.at + plan.postRollSeconds * 1000,
        kinds: [event.kind],
        origin: { kind: "camera-activity", policyId: plan.policyId },
      };
    } else
      capture = {
        ...capture,
        startAt: Math.min(capture.startAt, event.at),
        kinds: [...new Set([...capture.kinds, event.kind])],
        endAt: Math.min(
          Math.min(capture.startAt, event.at) + plan.maxEventSeconds * 1000,
          Math.max(capture.endAt, event.at + plan.postRollSeconds * 1000),
        ),
      };
    await session.ring.record({
      eventId: capture.id,
      startAt: capture.startAt - plan.preRollSeconds * 1000,
      endAt: capture.endAt,
      metadata: capture,
    });
    job.capture = capture;
    // The ordinary signed detector event tells a connected Helper to update
    // canonical activity state without creating a second recording ID.
    event.recordedEventId = capture.id;
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const [id, plan] of this.plans) {
        if (plan.expiresAt <= this.now()) {
          await this.release(id);
          continue;
        }
        if ((this.retry.get(id)?.until ?? 0) > this.now()) continue;
        try {
          let job = this.jobs.get(id);
          if (
            job &&
            (!same(job.plan, plan) || !this.cameras.sessions.has(job.sessionId))
          ) {
            await this.release(id);
            job = undefined;
          }
          const session = await this.cameras.acquire({
            ...plan,
            owner: owner(id),
          });
          if (
            this.stopped ||
            this.plans.get(id)?.expiresAt <= this.now() ||
            !same(this.plans.get(id), plan)
          ) {
            await this.release(id);
            continue;
          }
          if (job && job.sessionId !== session.id) {
            await this.detectors.remove(job.detectorId);
            this.jobs.delete(id);
            job = undefined;
          }
          if (!job) {
            job = {
              plan,
              sessionId: session.id,
              sequence: 0,
            };
            this.jobs.set(id, job);
          }
          let detector = this.detectors.jobs.get(job.detectorId);
          if (!detector && (job.inferenceAfter ?? 0) <= this.now()) {
            try {
              const started = this.detectors.start(undefined, plan.mode, {
                id: session.id,
                owner: owner(id),
              });
              job.detectorId = started.id;
              job.sequence = 0;
              detector = this.detectors.jobs.get(started.id);
            } catch {
              job.inferenceAfter = this.now() + 10000;
            }
          }
          // Analysis pressure must not disable independent native detections.
          // Keep the admitted shared ring; root-authenticated native triggers
          // use the same capture IDs while inference waits for capacity.
          if (!detector) continue;
          detector.until = this.now() + 45000;
          for (const event of detector.events) {
            if (event.sequence <= job.sequence) continue;
            await this.detect(id, event);
            job.sequence = event.sequence;
          }
          this.retry.delete(id);
        } catch {
          await this.release(id);
          this.retry.set(id, { until: this.now() + 10000 });
        }
      }
    } finally {
      this.busy = false;
    }
  }
  async stop() {
    await super.stop();
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.allSettled(this.detections.values());
    await Promise.allSettled(
      [...this.jobs.keys()].map((id) => this.release(id)),
    );
  }
}
