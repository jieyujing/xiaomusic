"""Extract the legacy settings UI contract without hand-dropping parameters."""

import json
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "xiaomusic/static/default/setting.html"
TARGET = ROOT / "xiaomusic/static/library/settings-schema.json"
VOID = {"input", "img", "meta", "link", "br", "hr", "source", "wbr"}


class Node:
    def __init__(self, tag="", attrs=None, parent=None):
        self.tag, self.attrs, self.parent = tag, dict(attrs or []), parent
        self.children = []

    def text(self):
        return " ".join(
            " ".join(
                c.text() if isinstance(c, Node) else c for c in self.children
            ).split()
        )

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()


class Document(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.current = self.root
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.current)
        self.current.children.append(node)
        if tag not in VOID:
            self.current = node

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        node = self.current
        while node.parent is not None:
            if node.tag == tag:
                self.current = node.parent
                return
            node = node.parent

    def handle_data(self, data):
        self.current.children.append(data)


def label_text(node):
    if node.tag in {"button", "a"} or "material-icons" in node.attrs.get("class", ""):
        return ""
    return " ".join(
        " ".join(
            label_text(c) if isinstance(c, Node) else c for c in node.children
        ).split()
    )


def generate():
    doc = Document(SOURCE.read_text())
    nodes = list(doc.root.walk())
    labels = {
        n.attrs["for"]: label_text(n).lstrip("*").rstrip(":：")
        for n in nodes
        if n.tag == "label" and "for" in n.attrs
    }
    groups = {
        n.attrs["data-tab"]: n.text()
        for n in nodes
        if n.tag == "button" and "config-tab-button" in n.attrs.get("class", "")
    }
    groups = {"account": "账号与连接", **groups}
    fields = []
    for n in nodes:
        key = n.attrs.get("id")
        if n.tag not in {"input", "select", "textarea"} or not key:
            continue
        group = "account"
        ancestor = n.parent
        while ancestor:
            if "config-tab-content" in ancestor.attrs.get("class", ""):
                group = ancestor.attrs.get("id", "").removeprefix("tab-")
                break
            ancestor = ancestor.parent
        options = [
            {
                "value": o.attrs.get("value", o.text()).replace(
                    "false selected", "false"
                ),
                "label": o.text(),
            }
            for o in n.walk()
            if o.tag == "option"
        ]
        fields.append(
            {
                "key": key,
                "label": labels.get(key, key),
                "group": group,
                "type": "select"
                if n.tag == "select"
                else "textarea"
                if n.tag == "textarea"
                else n.attrs.get("type", "text"),
                "options": options,
                "placeholder": n.attrs.get("placeholder", ""),
            }
        )
    result = {
        "source": "static/default/setting.html",
        "groups": [{"key": k, "label": v} for k, v in groups.items()],
        "fields": fields,
    }
    TARGET.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return result


if __name__ == "__main__":
    data = generate()
    print(f"Extracted {len(data['fields'])} fields in {len(data['groups'])} groups")
