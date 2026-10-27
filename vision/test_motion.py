import unittest
import json
import pathlib
import subprocess
import sys
import numpy as np
from motion import Foreground, Analysis, MovementTracks, WIDTH, HEIGHT, object_kind


class MotionTests(unittest.TestCase):
    def test_protocol_does_not_claim_calibrated_before_foreground_warmup(self):
        image = np.full((HEIGHT, WIDTH, 3), 35, dtype=np.uint8).tobytes()
        process = subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name('motion.py')), 'motion'], input=image*5, capture_output=True, timeout=10, check=True)
        frames = [json.loads(line) for line in process.stdout.splitlines() if json.loads(line)['type'] == 'frame']
        self.assertEqual([frame['calibrated'] for frame in frames], [False]*4+[True])
        self.assertTrue(all(not frame['detections'] for frame in frames))

    def test_noise_and_exposure_changes_do_not_trigger(self):
        gate = Foreground()
        rng = np.random.default_rng(12)
        for index in range(30):
            level = 40 if index < 15 else 100
            frame = np.clip(level + rng.normal(0, 2, (HEIGHT, WIDTH, 3)), 0, 255).astype(np.uint8)
            self.assertIsNone(gate.update(frame))

    def test_persistent_local_motion_is_confirmed_after_warmup(self):
        analysis = Analysis('motion')
        background = np.full((HEIGHT, WIDTH, 3), 35, dtype=np.uint8)
        for _ in range(6):
            self.assertEqual(analysis.analyze(background), [])
        found = []
        for index in range(8):
            frame = background.copy()
            frame[50:95, 30 + index * 8:65 + index * 8] = 200
            found.extend(analysis.analyze(frame))
        self.assertTrue(any(item['kind'] == 'motion' for item in found))

    def test_smart_model_runs_locally_without_detecting_an_empty_frame(self):
        analysis = Analysis('objects')
        self.assertEqual(len(analysis.model.infer(np.zeros((416, 416, 3), dtype=np.uint8))), 0)

    def test_large_textured_foreground_is_not_discarded_as_a_light_switch(self):
        gate = Foreground()
        background = np.full((HEIGHT, WIDTH, 3), 35, dtype=np.uint8)
        for _ in range(6):
            gate.update(background)
        rng = np.random.default_rng(99)
        found = False
        for _ in range(8):
            frame = background.copy()
            frame[5:175, 5:290] = rng.integers(90, 170, (170, 285, 3), dtype=np.uint8)
            found = found or gate.update(frame) is not None
        self.assertTrue(found)

    def test_small_pet_scores_do_not_lower_the_person_false_positive_threshold(self):
        self.assertEqual(object_kind([0, 0, 1, 1, 0.388, 16]), 'pet')
        self.assertIsNone(object_kind([0, 0, 1, 1, 0.404, 0]))

    def test_swaying_leaf_blob_does_not_become_sustained_travel(self):
        tracks = MovementTracks()
        for index in range(40):
            mask = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
            x = 90 + (3 if index % 2 else -3)
            mask[40:65, x:x+25] = 255
            self.assertFalse(tracks.update(mask))

    def test_coherent_small_object_travel_survives_sway_filter(self):
        tracks = MovementTracks()
        detected = []
        for index in range(8):
            mask = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
            mask[60:85, 30+index*8:55+index*8] = 255
            detected.append(tracks.update(mask))
        self.assertTrue(any(detected))

    def test_repeated_keyframes_are_not_new_activity_or_inference(self):
        class Model:
            calls = 0
            def infer(self, image):
                self.calls += 1
                return []
        model = Model()
        analysis = Analysis('objects', model=model)
        image = np.full((HEIGHT, WIDTH, 3), 40, dtype=np.uint8)
        for _ in range(20):
            self.assertEqual(analysis.analyze(image), [])
        self.assertEqual(model.calls, 0)

    def test_leaf_only_scene_does_not_promote_an_unmoving_person(self):
        class StaticPerson:
            def infer(self, image):
                return [[220, 120, 300, 300, 0.9, 0]]
        analysis = Analysis('objects', model=StaticPerson())
        for index in range(30):
            frame = np.full((HEIGHT, WIDTH, 3), 40, dtype=np.uint8)
            frame[10:35, 15+index%6:40+index%6] = 200
            self.assertEqual(analysis.analyze(frame), [])

    def test_objects_require_two_matching_observations_not_one_model_guess(self):
        class Model:
            def infer(self, image):
                return [[30, 130, 140, 270, 0.9, 0]]
        class Gate:
            def update(self, image):
                return np.full((HEIGHT, WIDTH), 255, dtype=np.uint8)
        analysis = Analysis('objects', model=Model())
        analysis.gate = Gate()
        first = np.full((HEIGHT, WIDTH, 3), 40, dtype=np.uint8)
        second = first.copy()
        second[30:80, 40:60] = 200
        self.assertEqual(analysis.analyze(first), [])
        self.assertEqual(analysis.analyze(second), [{'kind': 'person', 'confidence': 0.9}])


if __name__ == '__main__':
    unittest.main()
