"""Synthetic audit records based on the existing version-three export shape."""
import hashlib
import json


def write_bundle(path, bundle):
    content = {key: value for key, value in bundle.items() if key != 'hash'}
    raw = json.dumps(content, separators=(',', ':'), ensure_ascii=False)
    digest = hashlib.sha256(raw.encode()).hexdigest()
    path.write_text(raw[:-1] + ',"hash":"' + digest + '"}')
    return path


def tree_bundle(run_id='tree-1', *, slug='wind-prestudy', mode='tree', response=2, labels=('A', 'B'), config=None, profile=None):
    config = config or {'version': f'{slug}-3', 'experimentSlug': slug, 'mode': mode,
              'purpose': 'preparation', 'analysisProfileId': 'tree-development-1',
              'tree': {'preRollSeconds': 1, 'postRollSeconds': 1, 'responseSeconds': response,
                       'recoverySeconds': 0, 'announceRelease': False, 'count': len(labels)}}
    profile = profile or {'profileId': 'retained-wind-profile', 'version': 'wind-prestudy-profile-2'}
    sealed_config, sealed_profile = (json.dumps(item, separators=(',', ':')) for item in (config, profile))
    bundle = {'version': f'{slug}-3', 'experimentSlug': slug, 'runId': run_id,
              'bundleRevision': 1, 'config': config, 'sealedConfigJson': sealed_config,
              'configHash': hashlib.sha256(sealed_config.encode()).hexdigest(),
              'profile': profile, 'sealedProfileJson': sealed_profile,
              'profileHash': hashlib.sha256(sealed_profile.encode()).hexdigest(),
              'state': {'lifecycle': 'completed', 'createdAtMs': 1000, 'finishedAtMs': 10000},
              'events': [], 'cues': [], 'actions': [], 'tickets': [], 'clockReferences': []}
    def event(kind, at, data):
        bundle['events'].append({'experimentSlug': slug, 'runId': run_id,
                                'sequence': len(bundle['events']) + 1,
                                'kind': kind, 'actor': 'fixture', 'serverAtMs': at, 'data': data})
    event('start', 1000, {})
    for index, label in enumerate(labels):
        binding = {'experimentSlug': slug, 'runId': run_id, 'configHash': bundle['configHash'],
                   'stream': 'tree', 'opportunityId': f'target-{index + 1}'}
        at = round(2000 + index * (response + .1) * 1000)
        result = {'random': {'method': 'generateSignedIntegers', 'n': 1, 'min': 0, 'max': 1,
                            'replacement': True, 'data': [int(label == 'B')], 'userData': binding,
                            'ticketData': {'ticketId': f'ticket-{index}'}}, 'signature': 'synthetic-test-only'}
        bundle['tickets'].append({'ticketId': f'ticket-{index}', 'status': 'issued',
                                  'binding': binding, 'result': result,
                                  'rules': {'0': 'A', '1': 'B'},
                                  'verification': {'status': 'pending'}})
        event('assignmentRecorded', at, {'stream': 'tree', 'trialId': f'target-{index + 1}',
                                        'value': int(label == 'B'), 'ticketId': f'ticket-{index}'})
        bundle['cues'].append({'experimentSlug': slug, 'runId': run_id, 'cueId': f'cue-{index}',
                              'trialId': f'target-{index + 1}', 'stream': 'tree', 'text': label,
                              'dueAtMs': at, 'issuedAtMs': at, 'playedAtMs': at,
                              'deliveryStatus': 'played', 'deviceId': 'fixture-phone'})
        event('cuePlayed', at, {'cueId': f'cue-{index}', 'playedAtMs': at, 'timeSource': 'server_receipt'})
    event('away', round(3000 + len(labels) * (response + .1) * 1000), {})
    return bundle
