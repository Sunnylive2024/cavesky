import shutil
import unittest

from fastapi.testclient import TestClient

from cavesky.api import app, repository
from cavesky.models import FrameRange
from cavesky.planning import (
    ElementContext,
    MockPlanner,
    OpenAICompatPlanner,
    PlanRequest,
    PlannerError,
    PlannerNotConfiguredError,
    PlanProposal,
    PlanStep,
    create_action_group,
    sync_action_group_transitions,
)
from cavesky.planning.actions import compile_action_group_prompt
from cavesky.planning.openai_compat import parse_plan_proposal


def _member(member_id: str, kind: str, name: str) -> ElementContext:
    return ElementContext(id=member_id, kind=kind, name=name, activeRange=FrameRange(start=0, end=96))


def _scoped_request(members, anchor_frame=24, duration=96, description="女孩坐着，右手空闲"):
    return PlanRequest(
        shotId="SH002", fps=24, durationFrames=duration, members=members,
        desiredDurationFrames=min(48,duration-anchor_frame), targetEndFrame=min(duration,anchor_frame+48), modelDurationSeconds=list(range(2,16)),
        anchorFrame=anchor_frame, anchorDescription=description, actionIntent="转身并微笑",
    )


def _fresh_shot():
    shot = repository.get("SH002").model_copy(deep=True)
    shot.interactionGroups = []
    shot.transitions = []
    shot.generations = []
    return shot


class MockPlannerTests(unittest.TestCase):
    def test_mock_is_deterministic(self) -> None:
        request = _scoped_request([_member("CHAR_01", "character", "短发女性"), _member("PROP_CUP_01", "prop", "蓝色杯子")])
        self.assertEqual(MockPlanner().plan(request).model_dump(), MockPlanner().plan(request).model_dump())

    def test_mock_remaining_frames_after_anchor(self) -> None:
        proposal = MockPlanner().plan(_scoped_request([_member("CHAR_01", "character", "短发女性"), _member("PROP_CUP_01", "prop", "蓝色杯子")]))
        frames = [step.frame for step in proposal.steps]
        self.assertEqual(frames, sorted(frames))
        self.assertTrue(all(frame > 24 for frame in frames))
        self.assertTrue(all(frame <= 96 for frame in frames))

    def test_mock_single_member(self) -> None:
        proposal = MockPlanner().plan(_scoped_request([_member("CHAR_01", "character", "短发女性")]))
        self.assertEqual(len(proposal.steps), 3)
        self.assertEqual([step.phase for step in proposal.steps],["main","completion","hold"])
        for step in proposal.steps:
            self.assertEqual(step.memberIds, ["CHAR_01"])
            self.assertFalse(step.requiresInteractionGroup)


class CreateActionGroupTests(unittest.TestCase):
    def test_create_action_group_anchored(self) -> None:
        shot = _fresh_shot()
        before_groups = len(shot.interactionGroups)
        before_transitions = len(shot.transitions)
        proposal = PlanProposal(steps=[
            PlanStep(frame=48, memberIds=["CHAR_01", "PROP_CUP_01"], stateDescription="接触杯子", transitionDescription="稳定抓握", requiresInteractionGroup=True,phase="main"),
            PlanStep(frame=60, memberIds=["CHAR_01", "PROP_CUP_01"], stateDescription="拿起杯子", transitionDescription="保持", requiresInteractionGroup=True,phase="completion"),
            PlanStep(frame=72, memberIds=["CHAR_01", "PROP_CUP_01"], stateDescription="保持拿起", transitionDescription=None, requiresInteractionGroup=True,phase="hold",holdFrames=12),
        ])
        shot, group_id = create_action_group(shot, "CHARACTER_B5788215", "KF_FC03CDF0", ["CHARACTER_B5788215"], proposal, "转身并微笑", 72)
        self.assertEqual(len(shot.interactionGroups), before_groups + 1)
        group = next(group for group in shot.interactionGroups if group.id == group_id)
        self.assertEqual(group.anchorKeyframeId, "KF_FC03CDF0")
        self.assertEqual(group.members, ["CHARACTER_B5788215"])
        self.assertEqual((group.range.start, group.range.end), (24, 72))
        self.assertEqual([k.frame for k in group.keyframes], [48, 60, 72])
        self.assertEqual(len(shot.transitions), before_transitions + 1)
        prompt = shot.transitions[-1].instruction
        self.assertIn("0%（start）", prompt)
        self.assertIn("（main）", prompt)
        self.assertIn("保持", prompt)
        self.assertNotIn("第 24 帧", prompt)

    def test_create_action_group_requires_frames_after_anchor(self) -> None:
        shot = _fresh_shot()
        proposal = PlanProposal(steps=[PlanStep(frame=10,memberIds=["CHAR_01"],stateDescription="x",phase="main"),PlanStep(frame=12,memberIds=["CHAR_01"],stateDescription="y",phase="completion"),PlanStep(frame=14,memberIds=["CHAR_01"],stateDescription="z",phase="hold")])
        with self.assertRaises(ValueError):
            create_action_group(shot, "CHARACTER_B5788215", "KF_FC03CDF0", ["CHARACTER_B5788215"], proposal, "转身", 72)

    def test_create_action_group_missing_anchor(self) -> None:
        shot = _fresh_shot()
        proposal = PlanProposal(steps=[PlanStep(frame=48,memberIds=["CHAR_01"],stateDescription="x",phase="main"),PlanStep(frame=60,memberIds=["CHAR_01"],stateDescription="y",phase="completion"),PlanStep(frame=72,memberIds=["CHAR_01"],stateDescription="z",phase="hold")])
        with self.assertRaises(ValueError):
            create_action_group(shot, "CHARACTER_B5788215", "NOPE", ["CHARACTER_B5788215"], proposal, "转身", 72)

    def test_only_explicit_boundaries_split_group_transition(self) -> None:
        shot=_fresh_shot()
        proposal=PlanProposal(steps=[
            PlanStep(frame=32,memberIds=["CHARACTER_B5788215"],stateDescription="转身过程",phase="main"),
            PlanStep(frame=36,memberIds=["CHARACTER_B5788215"],stateDescription="转身完成",phase="completion"),
            PlanStep(frame=48,memberIds=["CHARACTER_B5788215"],stateDescription="保持姿态",phase="hold"),
        ])
        shot,group_id=create_action_group(shot,"CHARACTER_B5788215","KF_FC03CDF0",["CHARACTER_B5788215"],proposal,"转身",48)
        self.assertEqual([(item.fromFrame,item.toFrame) for item in shot.transitions],[(24,48)])
        group=next(item for item in shot.interactionGroups if item.id==group_id)
        group.keyframes[1].generationBoundary=True
        transitions=sync_action_group_transitions(shot,group_id)
        self.assertEqual([(item.fromFrame,item.toFrame) for item in transitions],[(24,36),(36,48)])
        self.assertIn("转身过程",transitions[0].instruction)


class OpenAICompatPlannerTests(unittest.TestCase):
    def test_capability_reports_configuration(self) -> None:
        configured = OpenAICompatPlanner(base_url="https://example/v1", api_key="k", model="qwen-flash")
        self.assertTrue(configured.capability.configured)
        unconfigured = OpenAICompatPlanner(base_url=None, api_key=None, model="qwen-flash")
        self.assertFalse(unconfigured.capability.configured)

    def test_plan_requires_configuration(self) -> None:
        planner = OpenAICompatPlanner(base_url=None, api_key="k", model="qwen-flash")
        with self.assertRaises(PlannerNotConfiguredError):
            planner.plan(_scoped_request([_member("CHAR_01", "character", "短发女性")]))

    def test_parse_plan_proposal_valid(self) -> None:
        proposal = parse_plan_proposal('{"steps":[{"frame":36,"memberIds":["CHAR_01"],"stateDescription":"伸手","phase":"main"},{"frame":48,"memberIds":["CHAR_01"],"stateDescription":"完成","phase":"completion"},{"frame":60,"memberIds":["CHAR_01"],"stateDescription":"保持","phase":"hold","holdFrames":12}]}')
        self.assertEqual(len(proposal.steps), 3)
        self.assertEqual(proposal.steps[0].frame, 36)

    def test_parse_plan_proposal_fenced(self) -> None:
        proposal = parse_plan_proposal('```json\n{"steps":[{"frame":1,"memberIds":["A"],"stateDescription":"m","phase":"main"},{"frame":2,"memberIds":["A"],"stateDescription":"c","phase":"completion"},{"frame":3,"memberIds":["A"],"stateDescription":"h","phase":"hold"}]}\n```')
        self.assertEqual(len(proposal.steps), 3)

    def test_parse_plan_proposal_empty(self) -> None:
        with self.assertRaises(PlannerError):
            parse_plan_proposal("")

    def test_parse_plan_proposal_invalid_schema(self) -> None:
        with self.assertRaises(PlannerError):
            parse_plan_proposal('{"wrong": true}')


class ActionGroupApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def _temp_shot(self):
        shot = _fresh_shot()
        shot.id = "SH_TEST"
        shot.interactionGroups = []
        shot.transitions = []
        shot.generations = []
        return shot

    def test_planning_adapters(self) -> None:
        response = self.client.get("/api/planning-adapters")
        self.assertEqual(response.status_code, 200)
        self.assertIn("mock", {item["id"] for item in response.json()})

    def test_create_action_group_single_member(self) -> None:
        shot = self._temp_shot()
        repository.save(shot)
        try:
            response = self.client.post("/api/action-groups", json={"shotId": "SH_TEST", "anchorKeyframeId": "KF_FC03CDF0", "actionIntent":"转身并微笑", "planner": "mock"})
            self.assertEqual(response.status_code, 200)
            group = response.json()["interactionGroups"][0]
            self.assertEqual(group["anchorKeyframeId"], "KF_FC03CDF0")
            self.assertEqual(group["members"], ["CHARACTER_B5788215"])
            self.assertEqual(group["range"]["start"], 24)
            self.assertTrue(all(k["frame"] > 24 for k in group["keyframes"]))
            history=response.json()["planningHistory"][0]
            self.assertEqual(history["status"],"succeeded")
            self.assertEqual(history["rawRequest"]["targetEndFrame"],72)
            self.assertEqual(history["rawRequest"]["desiredDurationFrames"],48)
            self.assertTrue(history["rawResponse"])
        finally:
            shutil.rmtree(repository.root / "SH_TEST", ignore_errors=True)

    def test_create_action_group_interaction(self) -> None:
        shot = self._temp_shot()
        second=shot.elements[0].model_copy(deep=True);second.id="PROP_A";second.keyframes=[]
        third=shot.elements[0].model_copy(deep=True);third.id="PROP_B";third.keyframes=[]
        shot.elements.extend([second,third])
        repository.save(shot)
        try:
            response = self.client.post("/api/action-groups", json={"shotId": "SH_TEST", "anchorKeyframeId": "KF_FC03CDF0", "memberIds": ["PROP_A","PROP_B","PROP_A"], "actionIntent":"同时整理两个物体", "planner": "mock"})
            self.assertEqual(response.status_code, 200)
            group=response.json()["interactionGroups"][0]
            self.assertEqual(group["kind"],"interaction")
            self.assertEqual(group["members"],["CHARACTER_B5788215","PROP_A","PROP_B"])
        finally:
            shutil.rmtree(repository.root / "SH_TEST", ignore_errors=True)

    def test_create_action_group_missing_anchor(self) -> None:
        response = self.client.post("/api/action-groups", json={"shotId": "SH002", "anchorKeyframeId": "NOPE", "actionIntent":"转身", "planner": "mock"})
        self.assertEqual(response.status_code, 422)

    def test_create_action_group_empty_description(self) -> None:
        shot = self._temp_shot()
        anchor = next(keyframe for element in shot.elements if element.id == "CHARACTER_B5788215" for keyframe in element.keyframes if keyframe.id == "KF_FC03CDF0")
        anchor.instruction = ""
        repository.save(shot)
        try:
            response = self.client.post("/api/action-groups", json={"shotId": "SH_TEST", "anchorKeyframeId": "KF_FC03CDF0", "actionIntent":"转身", "planner": "mock"})
            self.assertEqual(response.status_code, 422)
        finally:
            shutil.rmtree(repository.root / "SH_TEST", ignore_errors=True)

    def test_create_action_group_unknown_planner(self) -> None:
        response = self.client.post("/api/action-groups", json={"shotId": "SH002", "anchorKeyframeId": "KF_FC03CDF0", "actionIntent":"转身", "planner": "missing"})
        self.assertEqual(response.status_code, 422)

    def test_author_duration_sets_backend_target_before_planning(self) -> None:
        shot=self._temp_shot();repository.save(shot)
        try:
            response=self.client.post("/api/action-groups",json={"shotId":shot.id,"anchorKeyframeId":"KF_FC03CDF0","actionIntent":"转身","planner":"mock","desiredDurationFrames":24})
            self.assertEqual(response.status_code,200)
            payload=response.json()
            self.assertEqual(payload["interactionGroups"][0]["range"],{"start":24,"end":48})
            self.assertEqual(payload["planningHistory"][0]["rawRequest"]["modelDurationSeconds"],list(range(2,16)))
        finally:
            shutil.rmtree(repository.root/shot.id,ignore_errors=True)

    def test_invalid_sh003_is_isolated_from_normal_shot_list(self) -> None:
        self.assertNotIn("SH003",self.client.get("/api/shots").json())


if __name__ == "__main__":
    unittest.main()
