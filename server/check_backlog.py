import subprocess
import json
import os

api_key = os.environ.get('PAPERCLIP_API_KEY')
company_id = '46cad2c0-19f3-4a22-95d1-c5f3dcb0f096'

cmd = [
    'curl', '-s',
    '-H', f'Authorization: Bearer {api_key}',
    f'http://100.84.164.59:3100/api/companies/{company_id}/issues?status=backlog'
]

result = subprocess.run(cmd, capture_output=True, text=True)
issues = json.loads(result.stdout)

if not isinstance(issues, list):
    issues = issues.get('issues', [])

unassigned = [i for i in issues if not i.get('assigneeAgentId')]
no_project = [i for i in unassigned if not i.get('projectId')]

print(f"Backlog issues: {len(issues)}")
print(f"Unassigned: {len(unassigned)}")
print(f"Unassigned + no project: {len(no_project)}")

if no_project:
    print("\nTop 5 for routing:")
    for i in no_project[:5]:
        print(f"  {i['identifier']:8} {i['title'][:55]}")
