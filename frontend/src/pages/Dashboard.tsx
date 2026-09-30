import React from 'react';
import { Link } from 'react-router-dom';

// Mock hook
const useProjects = () => {
    return {
        data: [
            { id: 1, name: 'Project A', status: 'active' },
            { id: 2, name: 'Project B', status: 'active' },
        ],
        isLoading: false
    };
};

export const Dashboard: React.FC = () => {
    const { data: projects, isLoading } = useProjects();

    if (isLoading) return <div>Loading...</div>;

    return (
        <div className="p-4">
            <h1 className="text-2xl font-bold mb-4">Dashboard</h1>
            <div className="mb-8">
                <h2 className="text-xl font-semibold mb-2">Active Projects</h2>
                <ul className="space-y-2">
                    {projects?.map(project => (
                        <li key={project.id} className="p-4 border rounded shadow-sm">
                            <Link to={`/projects/${project.id}`} className="text-blue-500 hover:underline">
                                {project.name}
                            </Link>
                            <p className="text-sm text-gray-500">Status: {project.status}</p>
                        </li>
                    ))}
                </ul>
            </div>
            <div>
                <h2 className="text-xl font-semibold mb-2">Pending Notifications</h2>
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded">
                    <p>No new notifications at this time.</p>
                </div>
            </div>
        </div>
    );
};
