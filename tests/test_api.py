import shutil
import unittest

from fastapi.testclient import TestClient

from cavesky.api import app, repository


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_health(self) -> None:
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_mock_generation(self) -> None:
        shot=repository.get("SH002").model_copy(deep=True)
        shot.id="SH_API_TEST"
        repository.save(shot)
        transition_id=shot.transitions[0].id
        try:
            response = self.client.post(
                "/api/generations",
                json={
                    "shotId": shot.id,
                    "transitionId": transition_id,
                    "adapter": "mock",
                },
            )
            self.assertEqual(response.status_code, 202)
            self.assertEqual(response.json()["status"], "queued")
            job_response = self.client.get(f"/api/generations/{response.json()['id']}")
            self.assertEqual(job_response.json()["status"], "succeeded")
            self.assertEqual(job_response.json()["outputs"], [])
        finally:
            shutil.rmtree(repository.root / shot.id, ignore_errors=True)

    def test_generation_adapters(self) -> None:
        response = self.client.get("/api/generation-adapters")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()[0]["id"], "mock")
        adapter_ids = {item["id"] for item in response.json()}
        self.assertEqual(adapter_ids, {"mock", "qwen-image", "wan-image", "wan-kf2v", "wan-i2v-2.7"})

    def test_paid_generation_requires_quote_confirmation(self) -> None:
        payload={"shotId":"SH002","transitionId":"TR_6CB0D444","adapter":"wan-i2v-2.7","parameters":{"duration":2,"segmentCount":1}}
        quote=self.client.post("/api/generations/quote",json=payload)
        self.assertEqual(quote.status_code,200)
        self.assertEqual(quote.json()["estimatedCostCny"],1.2)
        self.assertEqual(quote.json()["timelineSeconds"],1.0)
        self.assertEqual(quote.json()["playbackSpeedRatio"],2.0)
        self.assertIn("动作意图",quote.json()["finalPrompt"])
        response=self.client.post("/api/generations",json=payload)
        self.assertEqual(response.status_code,409)
        self.assertEqual(response.json()["detail"]["code"],"confirmation_required")

    def test_wan_duration_must_be_integer_seconds(self) -> None:
        response=self.client.post("/api/generations/quote",json={"shotId":"SH002","transitionId":"TR_6CB0D444","adapter":"wan-i2v-2.7","parameters":{"duration":2.5}})
        self.assertEqual(response.status_code,422)

    def test_duplicate_paid_generation_is_rejected_before_adapter_call(self) -> None:
        shot=repository.get("SH002").model_copy(deep=True);shot.id="SH_QUOTE_TEST";repository.save(shot)
        try:
            payload={"shotId":shot.id,"transitionId":shot.transitions[0].id,"adapter":"wan-i2v-2.7","parameters":{"duration":2,"segmentCount":1}}
            quote=self.client.post("/api/generations/quote",json=payload).json()
            shot.generations.append({"id":"ARCHIVE_TEST","type":"transition","status":"succeeded","requestFingerprint":quote["fingerprint"]})
            repository.save(shot)
            response=self.client.post("/api/generations",json={**payload,"confirmationFingerprint":quote["fingerprint"]})
            self.assertEqual(response.status_code,409)
            self.assertEqual(response.json()["detail"]["code"],"duplicate_generation")
        finally:
            shutil.rmtree(repository.root / shot.id,ignore_errors=True)

    def test_unknown_generation_adapter(self) -> None:
        response = self.client.post(
            "/api/generations",
            json={
                "shotId": "SH002",
                "transitionId": "TR_6CB0D444",
                "adapter": "missing",
            },
        )
        self.assertEqual(response.status_code, 422)

    def test_keyframe_generation_rejects_unknown_target(self) -> None:
        response = self.client.post(
            "/api/keyframe-generations",
            json={
                "shotId": "SH002",
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
                "shotId": "SH002",
                "targetType": "interactionGroup",
                "targetId": "IG_PICKUP_CUP_01",
                "keyframeId": "IKF_PICKUP_024",
                "dataUrl": "not-a-png-data-url",
            },
        )
        self.assertEqual(response.status_code, 422)

    def test_video_frame_extraction_requires_accepted_generation(self) -> None:
        response=self.client.post("/api/video-frame-extractions",json={"shotId":"SH002","groupId":"IG_0BDBEE53","keyframeId":"IKF_C4F9EF68","generationId":"MISSING"})
        self.assertEqual(response.status_code,422)

    def test_rejected_generation_review_requires_and_saves_reason(self) -> None:
        shot=repository.get("SH002").model_copy(deep=True);shot.id="SH_REVIEW_TEST";shot.generations.append({"id":"GEN_REVIEW","type":"transition","adapter":"mock","status":"succeeded"});repository.save(shot)
        try:
            base={"shotId":shot.id,"generationId":"GEN_REVIEW","decision":"rejected","identityConsistent":True,"handednessConsistent":False,"limbsValid":True,"backgroundStable":True,"speedNatural":True}
            self.assertEqual(self.client.post("/api/generation-reviews",json=base).status_code,422)
            response=self.client.post("/api/generation-reviews",json={**base,"rejectionReason":"右手错误地变成左手"})
            self.assertEqual(response.status_code,200)
            record=next(item for item in response.json()["generations"] if item["id"]=="GEN_REVIEW")
            self.assertEqual(record["status"],"rejected")
            self.assertFalse(record["qualityReview"]["handednessConsistent"])
        finally:
            shutil.rmtree(repository.root/shot.id,ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
