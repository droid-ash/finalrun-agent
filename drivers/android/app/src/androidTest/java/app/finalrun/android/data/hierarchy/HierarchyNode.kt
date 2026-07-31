package app.finalrun.android.data.hierarchy

import android.graphics.Rect
import app.finalrun.android.action.NodeMatchResult
import app.finalrun.android.data.CLASS_NAME
import app.finalrun.android.data.CONTENT_DESC
import app.finalrun.android.data.ID
import app.finalrun.android.data.NodeAttr
import app.finalrun.android.data.NodeIdentifier
import app.finalrun.android.data.TEXT
import app.finalrun.android.debugLog
import org.json.JSONArray
import org.json.JSONException

val DEFAULT_PRIORITY_LIST = listOf(ID, CONTENT_DESC, CLASS_NAME, TEXT)

class HierarchyNode {

    var flattenedNodeMap: LinkedHashMap<String, AccNode> = linkedMapOf()
    var flattenedNode: List<AccNode> = ArrayList()

    fun getBounds(nodeIdentifier: NodeIdentifier?): Rect? {
        val matchingNode = getMatchingNodeWithResult(nodeIdentifier)?.matchingNode
        if (matchingNode != null) {
            debugLog(msg = "getBounds: ActionIdentifier : ${matchingNode.bounds} : \n ${matchingNode.toJSON()}")
            return matchingNode.bounds
        }
        return null
    }

    private fun findBestMatch(
        nodes: List<AccNode>,
        nodeAttr: NodeAttr,
        priorityList: List<String> = DEFAULT_PRIORITY_LIST
    ): NodeMatchResult {
        var currentMatches = nodes
        val matchedProperties = mutableListOf<String>()
        val unmatchedProperties = mutableListOf<String>()

        for (property in priorityList) {
            currentMatches = when (property) {
                ID -> if (nodeAttr.id != null && currentMatches.isNotEmpty()) {
                    currentMatches.filter { it.id == nodeAttr.id }.also {
                        if (it.isNotEmpty()) matchedProperties.add("$ID = ${it.first().id}")
                        else unmatchedProperties.add(ID)
                    }
                } else currentMatches

                CONTENT_DESC -> if (nodeAttr.contentDesc != null && currentMatches.isNotEmpty()) {
                    currentMatches.filter { it.contentDescription == nodeAttr.contentDesc }.also {
                        if (it.isNotEmpty()) {
                            matchedProperties.add("$CONTENT_DESC = ${it.first().contentDescription}")
                        } else unmatchedProperties.add(CONTENT_DESC)
                    }
                } else currentMatches

                CLASS_NAME -> if (nodeAttr.className != null && currentMatches.isNotEmpty()) {
                    currentMatches.filter { it.clazz == nodeAttr.className }.also {
                        if (it.isNotEmpty()) {
                            matchedProperties.add("$CLASS_NAME = ${it.first().clazz}")
                        } else unmatchedProperties.add(CLASS_NAME)
                    }
                } else currentMatches

                TEXT -> if (nodeAttr.text != null && currentMatches.isNotEmpty()) {
                    currentMatches.filter { it.text == nodeAttr.text }.also {
                        if (it.isNotEmpty()) {
                            matchedProperties.add("$TEXT = ${it.first().text}")
                        } else unmatchedProperties.add(TEXT)
                    }
                } else currentMatches

                else -> currentMatches  // Ignore unknown properties
            }

            if (currentMatches.size == 1) break
        }

        return NodeMatchResult(
            matchingNode = currentMatches.firstOrNull(),
            matchingNodes = currentMatches,
            matchedProps = matchedProperties,
            unmatchedProps = unmatchedProperties
        )
    }

    fun getMatchingNodeWithResult(nodeIdentifier: NodeIdentifier?): NodeMatchResult? {
        if (nodeIdentifier == null) return null
        if (nodeIdentifier.isUniquelyIdentifiable()) {
            val nodeAttr = nodeIdentifier.srcNodeAttr ?: return null
            val nodeMatchResult = findBestMatch(flattenedNode, nodeAttr)
            return nodeMatchResult
        } else {
            val srcNodeAttr = nodeIdentifier.srcNodeAttr
            val dstNodeAttr = nodeIdentifier.dstNodeAttr
            if (srcNodeAttr == null || dstNodeAttr == null) return null
            val matchingScrNodeMatchRes = findBestMatch(flattenedNode, srcNodeAttr)
            val matchingSrcNodes = matchingScrNodeMatchRes.matchingNodes

            //If matchingSrcNodes array is null or empty return the matching result for UI
            if (matchingSrcNodes == null || matchingSrcNodes.isEmpty()) return matchingScrNodeMatchRes

            if (nodeIdentifier.travelUpCount != -1) {
                if (nodeIdentifier.travelDownPath.isNullOrEmpty()) {
                    debugLog(msg = "getMatchingNode: Case: Child is unique, trying to find non-unique parent")
                    for (scrNode in matchingSrcNodes) {
                        val parentNode =
                            getParentAtTravelUpCount(scrNode, nodeIdentifier.travelUpCount)
                                ?: continue
                        debugLog(msg = "getMatchingNode: Case: Child is unique, trying to find non-unique parent: matched node: $parentNode")
                        if (parentNode.matches(nodeIdentifier.dstNodeAttr)) return NodeMatchResult(
                            matchingNode = parentNode
                        )
                    }
                } else {
                    debugLog(msg = "getMatchingNode: Case: Sibling is unique, trying to find non-unique sibling")
                    for (scrNode in matchingSrcNodes) {
                        val parentNode =
                            getParentAtTravelUpCount(scrNode, nodeIdentifier.travelUpCount)
                                ?: continue

                        val travelDownPath = nodeIdentifier.travelDownPath
                        val childNode = getChildFromPath(parentNode, travelDownPath) ?: continue
                        debugLog(msg = "getMatchingNode: Case: Sibling is unique, trying to find non-unique sibling: matched node: $childNode")
                        if (childNode.matches(nodeIdentifier.dstNodeAttr)) return NodeMatchResult(
                            matchingNode = childNode
                        )
                    }
                }
            } else {
                debugLog(msg = "getMatchingNode: Case: Parent is unique, trying to find non-unique child")
                for (parentNode in matchingSrcNodes) {
                    val travelDownPath = nodeIdentifier.travelDownPath ?: continue
                    val childNode = getChildFromPath(parentNode, travelDownPath) ?: continue
                    debugLog(msg = "getMatchingNode: Case: Parent is unique, trying to find non-unique child: matched node: $childNode")
                    if (childNode.matches(nodeIdentifier.dstNodeAttr)) return NodeMatchResult(
                        matchingNode = childNode
                    )
                }
            }
        }
        return null
    }

    /**
     * Retrieves the ancestor of a given node by traversing up the node hierarchy.
     *
     * This function starts at the provided `node` and recursively navigates up the hierarchy
     * based on the `travelUpCount`. It uses the `flattenedNodeMap` to find the parent of
     * each node during traversal.
     *
     * @param node The starting node for the traversal.
     * @param travelUpCount The number of levels to traverse up the hierarchy.
     * @return The ancestor node located `travelUpCount` levels above the provided `node`,
     *         or `null` if such an ancestor does not exist or if the traversal encounters
     *         a node without a parent in the `flattenedNodeMap`.
     */
    private fun getParentAtTravelUpCount(node: AccNode, travelUpCount: Int): AccNode? {
        if (travelUpCount == 0) {
            return node
        }
        val parentNode = flattenedNodeMap[node.parentId] ?: return null
        return getParentAtTravelUpCount(parentNode, travelUpCount - 1)
    }

    private fun getChildFromPath(node: AccNode, travelDownPath: String): AccNode? {

        val index = travelDownPath.indexOf('|')

        if (index == -1) {
            if (travelDownPath.isEmpty()) return null
            val childIndex = travelDownPath.toInt()
            if (childIndex > node.children.size - 1) {
                return null
            }

            val childId = node.children[childIndex]
            return flattenedNodeMap[childId]
        }

        val firstNodeIndex = travelDownPath.substring(0, index).toInt()
        if (firstNodeIndex > node.children.size - 1) {
            return null
        }

        val childId = node.children[firstNodeIndex]
        val firstNode = flattenedNodeMap[childId] ?: return null

        return getChildFromPath(firstNode, travelDownPath.substring(index + 1))
    }

    fun isVisible(nodeIdentifier: NodeIdentifier): Boolean {
        return getMatchingNodeWithResult(nodeIdentifier) != null
    }

    @Throws(JSONException::class)
    fun getFlattenedHierarchy(): JSONArray {
        val array = JSONArray()
        for (node in flattenedNode) {
            array.put(node.toJSON())
        }
        return array
    }

}
