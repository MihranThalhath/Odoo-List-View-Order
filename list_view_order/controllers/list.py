import odoo
import odoo.modules.registry
from odoo import http
from odoo.http import request


class ListOrder(http.Controller):

    def _get_model_fields(self, model):
        Model = request.env[model]
        fields = Model.fields_get(
            attributes=["string", "type", "required", "relation_field"]
        )
        return fields

    @http.route("/web/list/get_list_fields", type="json", auth="user")
    def get_list_fields(self, model) -> list:
        fields = self._get_model_fields(model)

        fields_sequence = sorted(
            fields.items(),
            key=lambda item: odoo.tools.ustr(item[1].get("string", item[0])).lower(),
        )

        records = [
            {
                "id": field_name,
                "name": field_name,
                "string": field.get("string", field_name),  # Use field_name fallback
                "field_type": field.get("type"),
                "required": field.get("required", False),
                "relation_field": field.get("relation_field"),
                "params": (
                    {"model": field.get("relation")}
                    if field.get("type") == "many2one"
                    else None
                ),
            }
            for field_name, field in fields_sequence
        ]

        return records

    @http.route("/web/list/get_current_list", type="json", auth="user")
    def get_current_list(self, user_id, model, view_id) -> list:
        ordered_field_data = request.env["list.order"].action_get_list_order(
            user_id, model, view_id
        )

        if not ordered_field_data:
            return []

        all_model_fields = self._get_model_fields(model)

        result = []
        for field_data in ordered_field_data:
            field_name = field_data["name"]
            model_field = all_model_fields.get(field_name)
            if model_field:
                label = field_data.get("string") or model_field.get(
                    "string", field_name
                )
                visibility = field_data.get("optional") or "always"
                result.append(
                    {
                        "label": label,
                        "name": field_name,
                        "visibility": visibility,  # Map False to 'always'
                        "string": label,  # Use same label
                        "widget": field_data.get("widget", ""),
                        "decorations": field_data.get("decorations", ""),
                    }
                )

        return result
