import unittest

from fastapi.testclient import TestClient

from cavesky.api import app


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_health(self) -> None:
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_mock_generation(self) -> None:
        response = self.client.post(
            "/api/generations",
            json={
                "shotId": "SH001",
                "transitionId": "TR_PICKUP_CUP_01",
                "adapter": "mock",
            },
        )
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["status"], "queued")
        job_response = self.client.get(f"/api/generations/{response.json()['id']}")
        self.assertEqual(job_response.json()["status"], "succeeded")
        self.assertEqual(job_response.json()["outputs"], [])

    def test_generation_adapters(self) -> None:
        response = self.client.get("/api/generation-adapters")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()[0]["id"], "mock")
        adapter_ids = {item["id"] for item in response.json()}
        self.assertEqual(adapter_ids, {"mock", "qwen-image", "wan-image", "wan-kf2v", "wan-i2v-2.7"})

    def test_unknown_generation_adapter(self) -> None:
        response = self.client.post(
            "/api/generations",
            json={
                "shotId": "SH001",
                "transitionId": "TR_PICKUP_CUP_01",
                "adapter": "missing",
            },
        )
        self.assertEqual(response.status_code, 422)

    def test_keyframe_generation_rejects_unknown_target(self) -> None:
        response = self.client.post(
            "/api/keyframe-generations",
            json={
                "shotId": "SH001",
                "targetType": "element",
                "targetId": "MISSING",
                "keyframeId": "MISSING",
                "instruction": "look up",
            },
        )
        self.assertEqual(response.status_code, 422)

    def test_reject_invalid_mask_data(self) -> None:
        response = self.client.post(
            "/api/masks",
            json={
                "shotId": "SH001",
                "targetType": "interactionGroup",
                "targetId": "IG_PICKUP_CUP_01",
                "keyframeId": "IKF_PICKUP_024",
                "dataUrl": "not-a-png-data-url",
            },
        )
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
