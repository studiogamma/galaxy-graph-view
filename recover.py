import json

filename = "/Users/sh/.gemini/antigravity-ide/brain/8dbc5a24-c8b6-4b1a-8ed1-52d3ee627654/.system_generated/logs/transcript_full.jsonl"

with open(filename, 'r') as f:
    for line in f:
        try:
            data = json.loads(line)
            if data.get('type') == 'PLANNER_RESPONSE':
                for call in data.get('tool_calls', []):
                    if call.get('name') == 'replace_file_content':
                        args = call.get('args', {})
                        if 'graph3d.ts' in args.get('TargetFile', ''):
                            print("--------------------------------------------------")
                            print("REPLACEMENT:", args.get('Description'))
                            print("TARGET CONTENT:")
                            print(args.get('TargetContent'))
                            print("REPLACEMENT CONTENT:")
                            print(args.get('ReplacementContent'))
                            print("--------------------------------------------------")
        except:
            pass
