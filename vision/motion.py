"""Bounded local analysis: persistent foreground, illumination rejection, optional NanoDet."""
import json
import os
import sys
import time
import cv2
import numpy as np
from nanodet import NanoDet

cv2.setNumThreads(1)
WIDTH, HEIGHT = 320, 180
GROUPS = {0: 'person', 1: 'vehicle', 2: 'vehicle', 3: 'vehicle', 5: 'vehicle',
          7: 'vehicle', 14: 'pet', 15: 'pet', 16: 'pet'}
THRESHOLDS = {'person': 0.5, 'vehicle': 0.5, 'pet': 0.35}


def overlap(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    shared = max(0, x2-x1) * max(0, y2-y1)
    return shared / max(1, (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - shared)


class MovementTracks:
    """Reject small local oscillation; bounded coherent trajectories, no optical flow."""
    def __init__(self):
        self.tracks = []

    def update(self, mask):
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        tracks = []
        detected = False
        for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:8]:
            if cv2.contourArea(contour) < mask.size * 0.002:
                continue
            x, y, w, h = cv2.boundingRect(contour)
            box = (x, y, x+w, y+h)
            previous = max(self.tracks, key=lambda t: overlap(t['box'], box), default=None)
            center = np.array([x+w/2, y+h/2])
            if previous and overlap(previous['box'], box) > 0.1:
                points = (previous['points'] + [center])[-5:]
            else:
                points = [center]
            tracks.append({'box': box, 'points': points})
            if len(points) >= 3:
                distance = float(np.linalg.norm(points[-1]-points[0]))
                path = sum(float(np.linalg.norm(b-a)) for a, b in zip(points, points[1:]))
                detected |= distance >= 12 and distance / max(1, path) >= 0.65
        self.tracks = tracks
        return detected


def object_kind(prediction):
    kind = GROUPS.get(int(prediction[-1]))
    return kind if kind and prediction[-2] >= THRESHOLDS[kind] else None


class Foreground:
    def __init__(self):
        self.background = None
        self.frames = 0
        self.held = 0

    def update(self, image):
        gray = cv2.GaussianBlur(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        self.frames += 1
        if self.background is None:
            self.background = gray.astype(np.float32)
        difference = gray.astype(np.float32) - self.background
        # Reject exposure changes, lights switching and camera IR transitions.
        shift = float(np.median(difference))
        uniform = float(np.mean(np.abs(difference - shift) < 8))
        if abs(shift) > 12 and uniform > 0.8:
            self.background = gray.astype(np.float32)
            self.held = 0
            return None
        difference = np.abs(difference - shift)
        noise = float(np.percentile(difference, 25))
        mask = (difference > max(12, noise * 3 + 6)).astype(np.uint8) * 255
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        components, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        largest = max((cv2.contourArea(component) for component in components), default=0)
        ratio = cv2.countNonZero(mask) / mask.size
        moving = self.frames > 4 and 0.002 < ratio < 0.9 and largest > mask.size * 0.002
        self.held = self.held + 1 if moving else 0
        cv2.accumulateWeighted(gray, self.background, 0.035 if moving else 0.12)
        return mask if self.held >= 2 else None


class Analysis:
    def __init__(self, mode='objects', model=None):
        self.gate = Foreground()
        self.mode = mode
        self.model = (model or NanoDet(os.path.join(os.path.dirname(__file__), 'model.onnx'), 0.35)) if mode == 'objects' else None
        self.previous = None
        self.confirmations = []
        self.tracks = MovementTracks()

    def analyze(self, image):
        # The low-cost decoder may repeat a keyframe. Repetition is not activity
        # or another independent object confirmation.
        repeated = self.previous is not None and np.array_equal(self.previous, image)
        self.previous = image.copy()
        mask = self.gate.update(image)
        if mask is None:
            self.confirmations = []
            self.tracks.tracks = []
            return []
        if repeated:
            return []
        if self.mode == 'motion':
            return [{'kind': 'motion', 'confidence': 1}] if self.tracks.update(mask) else []
        height = round(416 * HEIGHT / WIDTH)
        top = (416 - height) // 2
        resized = cv2.resize(cv2.cvtColor(image, cv2.COLOR_BGR2RGB), (416, height), interpolation=cv2.INTER_AREA)
        padded = cv2.copyMakeBorder(resized, top, 416 - height - top, 0, 0, cv2.BORDER_CONSTANT)
        found = {}
        candidates = []
        for prediction in self.model.infer(padded):
            kind = object_kind(prediction)
            if kind is None:
                continue
            x1, y1, x2, y2 = prediction[:4]
            x1, x2 = max(0, int(x1 * WIDTH / 416)), min(WIDTH, int(x2 * WIDTH / 416))
            y1, y2 = max(0, int((y1 - top) * HEIGHT / height)), min(HEIGHT, int((y2 - top) * HEIGHT / height))
            region = mask[y1:y2, x1:x2]
            # A static person beside moving leaves must not turn every shadow into an event.
            if region.size and cv2.countNonZero(region) / region.size > 0.015:
                box = (x1, y1, x2, y2)
                candidates.append((kind, box))
                if any(old_kind == kind and overlap(old_box, box) > 0.15 for old_kind, old_box in self.confirmations):
                    found[kind] = max(found.get(kind, 0), float(prediction[-2]))
        self.confirmations = candidates[:32]
        return [{'kind': kind, 'confidence': score} for kind, score in found.items()]


def main():
    analysis = Analysis(sys.argv[1] if len(sys.argv) > 1 else 'objects')
    print(json.dumps({'type': 'ready'}), flush=True)
    size = WIDTH * HEIGHT * 3
    while True:
        data = sys.stdin.buffer.read(size)
        if len(data) != size:
            break
        started = time.monotonic()
        detections = analysis.analyze(np.frombuffer(data, dtype=np.uint8).reshape(HEIGHT, WIDTH, 3))
        print(json.dumps({'type': 'frame', 'detections': detections, 'processingMs': round((time.monotonic() - started) * 1000)}), flush=True)


if __name__ == '__main__':
    main()
