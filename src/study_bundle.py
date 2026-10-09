"""Validate one exact, immutable hosted wind-run export before local analysis."""

import hashlib
import json
import math
from pathlib import Path
import re


VERSION = "wind-prestudy-3"
EXPERIMENT_SLUG = "wind-prestudy"
_TERMINAL = {"completed", "stopped", "failed"}
_FINAL_HASH = re.compile(rb',"hash":"([0-9a-f]{64})"}$')


def _reject_constant(value):
    raise ValueError(f"run bundle contains non-finite JSON value {value}")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"run bundle contains duplicate JSON key {key}")
        result[key] = value
    return result


def _load_json(raw):
    try:
        return json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("run bundle is not valid UTF-8 JSON") from error


def _same_json(left, right):
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(_same_json(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(_same_json(a, b) for a, b in zip(left, right))
    return left == right


def _nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def _ms(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def _check_identity(value, run_id, subject, experiment_slug):
    if not isinstance(value, dict) or value.get("experimentSlug") != experiment_slug or value.get("runId") != run_id:
        raise ValueError(f"{subject} has a mismatching experiment or run identity")


def _check_events(events, run_id, experiment_slug):
    if not isinstance(events, list):
        raise ValueError("run bundle events must be a list")
    for expected_sequence, event in enumerate(events, 1):
        _check_identity(event, run_id, "event", experiment_slug)
        if event.get("sequence") != expected_sequence or type(event.get("sequence")) is not int:
            raise ValueError("run bundle event sequence must be consecutive from one")
        if not _ms(event.get("serverAtMs")):
            raise ValueError("run bundle event time must be UTC milliseconds")
        if not _nonempty(event.get("kind")) or not _nonempty(event.get("actor")):
            raise ValueError("run bundle event needs kind and actor")
        if event.get("actionId") is not None and not _nonempty(event["actionId"]):
            raise ValueError("run bundle event actionId must be nonempty when present")
        if "data" in event and not isinstance(event["data"], dict):
            raise ValueError("run bundle event data must be an object")


def _check_cues(cues, run_id, experiment_slug):
    if not isinstance(cues, list):
        raise ValueError("run bundle cues must be a list")
    cue_ids = set()
    trial_ids = set()
    trial_bindings = set()
    for cue in cues:
        _check_identity(cue, run_id, "cue", experiment_slug)
        cue_id = cue.get("cueId")
        if not _nonempty(cue_id) or cue_id in cue_ids:
            raise ValueError("run bundle cueId must be unique and nonempty")
        cue_ids.add(cue_id)
        trial_id = cue.get("trialId")
        if trial_id is not None:
            if not _nonempty(trial_id) or trial_id in trial_ids:
                raise ValueError("run bundle trialId must be unique and nonempty")
            trial_ids.add(trial_id)
            if not _nonempty(cue.get("stream")):
                raise ValueError("run bundle trial cue needs a stream")
            trial_bindings.add((cue["stream"], trial_id))
        if not _nonempty(cue.get("text")) or not _nonempty(cue.get("deliveryStatus")):
            raise ValueError("run bundle cue needs text and deliveryStatus")
        if not _ms(cue.get("dueAtMs")) or not _ms(cue.get("issuedAtMs")):
            raise ValueError("run bundle cue needs due and issue UTC milliseconds")
        if cue.get("playedAtMs") is not None and (
                not _ms(cue["playedAtMs"]) or cue["playedAtMs"] < cue["issuedAtMs"]):
            raise ValueError("run bundle cue playback must follow issue")
    return cue_ids, trial_bindings


def _check_actions(actions, run_id, experiment_slug):
    if not isinstance(actions, list):
        raise ValueError("run bundle actions must be a list")
    identifiers = set()
    for action in actions:
        if not isinstance(action, dict):
            raise ValueError("run bundle action must be an object")
        if (action.get("experimentSlug") not in (None, experiment_slug) or
                action.get("runId") not in (None, run_id)):
            raise ValueError("run bundle action has a mismatching experiment or run identity")
        action_id = action.get("actionId")
        if not _nonempty(action_id) or action_id in identifiers:
            raise ValueError("run bundle actionId must be unique and nonempty")
        identifiers.add(action_id)


def _check_tickets(tickets, run_id, config_hash, experiment_slug):
    if not isinstance(tickets, list):
        raise ValueError("run bundle tickets must be a list")
    identifiers = set()
    opportunities = set()
    for ticket in tickets:
        ticket_id = ticket.get("ticketId") if isinstance(ticket, dict) else None
        if not _nonempty(ticket_id) or ticket_id in identifiers:
            raise ValueError("run bundle ticketId must be unique and nonempty")
        identifiers.add(ticket_id)
        binding = ticket.get("binding")
        if (not isinstance(binding, dict) or binding.get("experimentSlug") != experiment_slug or
                binding.get("runId") != run_id or binding.get("configHash") != config_hash):
            raise ValueError("run bundle ticket binding mismatches its run or configuration")
        if not _nonempty(binding.get("stream")) or not _nonempty(binding.get("opportunityId")):
            raise ValueError("run bundle ticket binding needs a stream and opportunity")
        opportunity = (binding["stream"], binding["opportunityId"])
        if opportunity in opportunities:
            raise ValueError("run bundle ticket opportunity must be unique")
        opportunities.add(opportunity)
        status = ticket.get("status")
        if status not in ("unused", "reserved", "issued"):
            raise ValueError("run bundle ticket has an unknown status")
        if status == "issued":
            result = ticket.get("result")
            if not isinstance(result, dict) or not isinstance(result.get("random"), dict) or not _nonempty(result.get("signature")):
                raise ValueError("issued ticket lacks its signed provider result")
        elif ticket.get("result") is not None:
            raise ValueError("unused or reserved ticket unexpectedly contains a result")
    return opportunities


def bundle_file_sha256(path):
    """Hash exact downloaded bytes, independently of any parsed JSON representation."""
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def load_run_bundle(path):
    """Read a terminal export and reject identity, hash, ordering or trial damage.

    The hosted exporter writes minified JSON.stringify bytes with `hash` last.
    The content hash is checked against those exact bytes, avoiding different
    JavaScript/Python float formatting for captured GPS coordinates. The caller
    also retains `bundle_file_sha256(path)` as the local original-file identity.
    """
    raw = Path(path).read_bytes()
    bundle = _load_json(raw)
    if not isinstance(bundle, dict):
        raise ValueError("run bundle root must be an object")
    final_hash = _FINAL_HASH.search(raw)
    if not final_hash or bundle.get("hash") != final_hash.group(1).decode("ascii"):
        raise ValueError("run bundle hash requires the exact hosted JSON export bytes")
    content_hash = hashlib.sha256(raw[:final_hash.start()] + b"}").hexdigest()
    if content_hash != bundle["hash"]:
        raise ValueError("run bundle hash does not match its exported bytes")
    experiment_slug = bundle.get("experimentSlug")
    if experiment_slug not in ("tree-targeting", "wind-prestudy"):
        raise ValueError("run bundle experiment identity is not supported")
    version = f"{experiment_slug}-3"
    if bundle.get("version") != version:
        raise ValueError(f"run bundle version must be {VERSION}")
    if bundle.get("experimentSlug") != experiment_slug:
        raise ValueError("run bundle experiment identity does not match wind-prestudy")
    run_id = bundle.get("runId")
    if not _nonempty(run_id):
        raise ValueError("run bundle needs a nonempty runId")
    state = bundle.get("state")
    if not isinstance(state, dict) or state.get("lifecycle") not in _TERMINAL:
        raise ValueError("run bundle must be terminal before analysis")
    revision = bundle.get("bundleRevision")
    if type(revision) is not int or revision < 1:
        raise ValueError("run bundle needs a positive immutable revision")
    for name, seal_name, hash_name in (("config", "sealedConfigJson", "configHash"),
                                       ("profile", "sealedProfileJson", "profileHash")):
        description = "configuration" if name == "config" else "profile"
        sealed = bundle.get(seal_name)
        digest = bundle.get(hash_name)
        if not isinstance(sealed, str) or not isinstance(digest, str) or len(digest) != 64:
            raise ValueError(f"run bundle has no sealed {description} and hash")
        if hashlib.sha256(sealed.encode("utf-8")).hexdigest() != digest:
            raise ValueError(f"run bundle {description} hash mismatch")
        parsed = _load_json(sealed)
        if not _same_json(parsed, bundle.get(name)):
            raise ValueError(f"run bundle displayed {description} differs from its sealed record")
    config = bundle["config"]
    if not isinstance(config, dict) or config.get("experimentSlug") != experiment_slug:
        raise ValueError("run bundle configuration has the wrong experiment identity")
    if config.get("version") != version:
        raise ValueError("run bundle configuration has the wrong version")
    if config.get("mode") != "tree" or config.get("purpose") not in ("preparation", "scored"):
        raise ValueError("run bundle configuration must be Tree with a valid purpose")
    _check_events(bundle.get("events"), run_id, experiment_slug)
    cue_ids, trial_bindings = _check_cues(bundle.get("cues"), run_id, experiment_slug)
    _check_actions(bundle.get("actions"), run_id, experiment_slug)
    opportunities = _check_tickets(bundle.get("tickets"), run_id, bundle["configHash"], experiment_slug)
    if not trial_bindings <= opportunities:
        raise ValueError("run bundle cue has an unplanned trialId")
    for event in bundle["events"]:
        if event["kind"] in ("cuePlayed", "cueFailed"):
            cue_id = event.get("data", {}).get("cueId")
            if cue_id not in cue_ids:
                raise ValueError("run bundle playback event references an unknown cueId")
    clocks = bundle.get("clockReferences")
    if not isinstance(clocks, list):
        raise ValueError("run bundle clockReferences must be a list")
    return bundle


def load_series_bundle(path):
    """Validate the existing hosted series export without inventing a run export."""
    value = _load_json(Path(path).read_bytes())
    identifier = lambda item: isinstance(item, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,80}', item)
    digest = lambda item: isinstance(item, str) and re.fullmatch(r'[a-f0-9]{64}', item)
    checkpoint = lambda item: isinstance(item, str) and re.fullmatch(r'(?:[a-f0-9]{40}|[a-f0-9]{64})', item)
    if (not isinstance(value, dict) or value.get('experimentSlug') != 'tree-targeting' or
            not identifier(value.get('seriesId')) or not _nonempty(value.get('label')) or
            value.get('status') not in ('open', 'draft', 'frozen') or not _ms(value.get('createdAtMs')) or
            not checkpoint(value.get('codeCheckpoint'))):
        raise ValueError('Series bundle identity, creation time or source checkpoint is invalid')
    for name in ('config', 'profile'):
        sealed = value.get('sealed' + name.capitalize() + 'Json')
        if (not isinstance(sealed, str) or not digest(value.get(name + 'Hash')) or
                hashlib.sha256(sealed.encode()).hexdigest() != value[name + 'Hash'] or
                not _same_json(_load_json(sealed), value.get(name))):
            raise ValueError(f'Series bundle sealed {name} or hash changed')
    config = value['config']
    if (config.get('seriesId') != value['seriesId'] or config.get('experimentSlug') != 'tree-targeting' or
            config.get('version') != 'tree-targeting-3' or config.get('mode') != 'tree' or
            config.get('purpose') not in ('preparation', 'scored')):
        raise ValueError('Series bundle must retain its own Tree configuration and purpose')
    from study_profiles import validate_profile
    validate_profile(value['profile'])
    if value['profile']['profileId'] != config.get('analysisProfileId'):
        raise ValueError('Series profile differs from its saved configuration')
    members = value.get('members')
    if not isinstance(members, list):
        raise ValueError('Series bundle needs its complete recording inventory')
    for member in members:
        if (not isinstance(member, dict) or not identifier(member.get('runId')) or
                not digest(member.get('configHash')) or not digest(member.get('profileHash')) or
                not checkpoint(member.get('codeCheckpoint')) or not _ms(member.get('createdAtMs')) or
                member.get('collectionStartedAtMs') is not None and
                (not _ms(member['collectionStartedAtMs']) or member['collectionStartedAtMs'] < member['createdAtMs'])):
            raise ValueError('Series member identity, hashes or collection time is invalid')
    run_ids = [member['runId'] for member in members]
    if len(set(run_ids)) != len(run_ids) or value.get('runIds') != run_ids:
        raise ValueError('Series recording inventory must be unique and match its ordered members')
    collected = {member['runId']: member['collectionStartedAtMs'] for member in members if member['collectionStartedAtMs'] is not None}
    collection_order = value.get('collectionRunIds')
    if (not isinstance(collection_order, list) or len(collection_order) != len(collected) or
            set(collection_order) != set(collected) or
            any(collected[left] > collected[right] for left, right in zip(collection_order, collection_order[1:]))):
        raise ValueError('Series collection order does not match its collected recording inventory')
    return value
