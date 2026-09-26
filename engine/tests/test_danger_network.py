from app.danger_wallets import _network


def _t(funders=(), sent=(), got=()):
    return {"funders": list(funders), "sent_to": list(sent), "received_from": list(got)}


def test_shared_funder_groups_creators_but_exchange_does_not():
    traces = {
        "C1": _t([{"wallet": "F", "sol": 2, "at": 1}], [{"wallet": "CEX", "sol": 5, "first_at": 3, "busy": True}]),
        "C2": _t([{"wallet": "F", "sol": 1, "at": 1}]),
        "C3": _t(sent=[{"wallet": "CEX", "sol": 1, "first_at": 3, "busy": True}]),
    }
    net = _network({"C1", "C2", "C3"}, traces)
    assert [g["wallets"] for g in net["groups"]] == [["C1", "C2"]]
    linked = {l["wallet"]: l for l in net["linked"]}
    assert linked["F"]["creators"] == ["C1", "C2"] and linked["F"]["roles"] == ["pendana"]
    assert "CEX" not in linked and net["busy"] == ["CEX"]


def test_creators_paying_each_other_are_one_group():
    net = _network({"A", "B"}, {"A": _t(sent=[{"wallet": "B", "sol": 3, "first_at": 5}])})
    assert net["groups"] == [{"id": 1, "wallets": ["A", "B"]}]
