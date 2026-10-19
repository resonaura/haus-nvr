import unittest
import numpy as np
from motion import Foreground, Analysis, WIDTH, HEIGHT, object_kind


class MotionTests(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
