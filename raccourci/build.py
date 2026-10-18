import plistlib, uuid, sys

APP_URL = "https://elouantanguyrollier-cloud.github.io/etr-budget/"
U_AMOUNT, U_MERCHANT, U_URL = (str(uuid.uuid4()).upper() for _ in range(3))

def ref(uid, name):
    return {"OutputUUID": uid, "OutputName": name, "Type": "ActionOutput"}

# URL = APP_URL#ajout?montant=<Montant>&marchand=<Commerçant>
prefix = APP_URL + "#ajout?montant="
mid = "&marchand="
text = prefix + "￼" + mid + "￼"
pos1 = len(prefix)
pos2 = pos1 + 1 + len(mid)

actions = [
    {   # 1. Demander le montant
        "WFWorkflowActionIdentifier": "is.workflow.actions.ask",
        "WFWorkflowActionParameters": {
            "UUID": U_AMOUNT,
            "WFAskActionPrompt": "Montant dépensé (€) ?",
            "WFInputType": "Number",
        },
    },
    {   # 2. Demander le commerçant
        "WFWorkflowActionIdentifier": "is.workflow.actions.ask",
        "WFWorkflowActionParameters": {
            "UUID": U_MERCHANT,
            "WFAskActionPrompt": "Où ? (commerçant)",
            "WFInputType": "Text",
        },
    },
    {   # 3. Construire le lien
        "WFWorkflowActionIdentifier": "is.workflow.actions.url",
        "WFWorkflowActionParameters": {
            "UUID": U_URL,
            "WFURLActionURL": {
                "Value": {
                    "string": text,
                    "attachmentsByRange": {
                        "{%d, 1}" % pos1: ref(U_AMOUNT, "Fourni lors de l’exécution"),
                        "{%d, 1}" % pos2: ref(U_MERCHANT, "Fourni lors de l’exécution"),
                    },
                },
                "WFSerializationType": "WFTextTokenString",
            },
        },
    },
    {   # 4. Ouvrir
        "WFWorkflowActionIdentifier": "is.workflow.actions.openurl",
        "WFWorkflowActionParameters": {
            "WFInput": {
                "Value": ref(U_URL, "URL"),
                "WFSerializationType": "WFTextTokenAttachment",
            },
        },
    },
]

shortcut = {
    "WFWorkflowActions": actions,
    "WFWorkflowClientVersion": "2900",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowHasShortcutInputVariables": False,
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59511},
    "WFWorkflowImportQuestions": [],
    "WFWorkflowInputContentItemClasses": [],
    "WFWorkflowTypes": [],
}
with open(sys.argv[1], "wb") as f:
    plistlib.dump(shortcut, f, fmt=plistlib.FMT_BINARY)
print("ok", sys.argv[1])
